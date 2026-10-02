"""Bounded, back-pressured stages so a library's size cannot exhaust memory.

Every stage here has a maximum queue depth. When a downstream stage falls
behind, the upstream one *blocks* rather than buffering — which is the whole
point: a producer that never waits is a producer that turns a two-million-file
library into an out-of-memory crash.

Concurrency is chosen per workload class, not globally. Reading from a network
share wants many waiting threads; hashing wants roughly one per core; database
writes want exactly one, because a second writer only produces contention. The
defaults adapt from observed latency but never claim to know what storage is
underneath — a slow root is reported as slow, not diagnosed as a spinning disk.
"""

from __future__ import annotations

import queue
import threading
import time
from collections.abc import Callable, Iterable, Iterator
from dataclasses import dataclass, field
from typing import Any, Generic, Literal, TypeVar

from app.core.logging_config import get_logger

logger = get_logger(__name__)

T = TypeVar("T")
R = TypeVar("R")

WorkloadClass = Literal["io_bound", "cpu_bound", "database", "extraction"]

#: Hard ceilings. An expert override may lower these; nothing may raise them,
#: because they are what stops a misconfiguration from taking the machine down.
MAX_WORKERS = 32
MAX_QUEUE_DEPTH = 10_000
DEFAULT_QUEUE_DEPTH = 500

#: Latency above which a stage is reported as slow. Chosen to be well past any
#: local disk and comfortably inside a stalling network share.
SLOW_ITEM_SECONDS = 2.0


@dataclass(frozen=True)
class ResourceCeilings:
    """What this machine is allowed to spend, before any adaptation."""

    logical_cpus: int = 4
    io_workers: int | None = None
    cpu_workers: int | None = None
    queue_depth: int = DEFAULT_QUEUE_DEPTH
    #: Set by the user in expert mode. Clamped to the hard ceilings above.
    memory_limit_mib: int | None = None

    def workers_for(self, workload: WorkloadClass) -> int:
        """Conservative defaults, overridable, always clamped."""
        if workload == "database":
            return 1  # one writer, always: a second only creates contention
        if workload == "io_bound":
            chosen = self.io_workers or min(8, max(2, self.logical_cpus * 2))
        elif workload == "cpu_bound":
            chosen = self.cpu_workers or max(1, self.logical_cpus - 1)
        else:
            chosen = self.cpu_workers or max(1, self.logical_cpus // 2)
        return max(1, min(chosen, MAX_WORKERS))

    def depth(self) -> int:
        return max(1, min(self.queue_depth, MAX_QUEUE_DEPTH))


@dataclass
class StageDiagnostics:
    """Live counters a diagnostics panel can render without stopping anything."""

    name: str
    workload: WorkloadClass
    workers: int
    max_depth: int
    queued: int = 0
    peak_queued: int = 0
    processed: int = 0
    failed: int = 0
    blocked_count: int = 0
    slow_items: int = 0
    total_seconds: float = 0.0

    @property
    def throughput_per_second(self) -> float:
        return 0.0 if self.total_seconds <= 0 else self.processed / self.total_seconds

    @property
    def saturated(self) -> bool:
        """Whether producers are being made to wait, i.e. this stage is the limit."""
        return self.blocked_count > 0

    def snapshot(self) -> dict[str, Any]:
        return {
            "name": self.name,
            "workload": self.workload,
            "workers": self.workers,
            "max_depth": self.max_depth,
            "queued": self.queued,
            "peak_queued": self.peak_queued,
            "processed": self.processed,
            "failed": self.failed,
            "slow_items": self.slow_items,
            "saturated": self.saturated,
            "throughput_per_second": round(self.throughput_per_second, 2),
        }


class CancelledStage(RuntimeError):
    """The stage stopped because cancellation was requested."""


class BoundedStage(Generic[T, R]):
    """One work stage with a fixed queue depth and a worker pool.

    Results are yielded as they finish. Order is not preserved: a stage that had
    to preserve order would have to buffer, and buffering is the thing this
    class exists to prevent.
    """

    def __init__(
        self,
        name: str,
        work: Callable[[T], R],
        *,
        workload: WorkloadClass = "io_bound",
        ceilings: ResourceCeilings | None = None,
        on_error: Callable[[T, Exception], None] | None = None,
    ) -> None:
        self.ceilings = ceilings or ResourceCeilings()
        self.work = work
        self.on_error = on_error
        self.diagnostics = StageDiagnostics(
            name=name,
            workload=workload,
            workers=self.ceilings.workers_for(workload),
            max_depth=self.ceilings.depth(),
        )
        self._input: queue.Queue[Any] = queue.Queue(maxsize=self.diagnostics.max_depth)
        self._output: queue.Queue[Any] = queue.Queue(maxsize=self.diagnostics.max_depth)
        self._lock = threading.Lock()

    def run(
        self,
        items: Iterable[T],
        *,
        cancel: Callable[[], bool] | None = None,
    ) -> Iterator[R]:
        """Feed *items* through the stage, yielding results as they complete."""
        sentinel = object()
        started = time.monotonic()
        threads = [
            threading.Thread(
                target=self._worker,
                args=(sentinel, cancel),
                name=f"{self.diagnostics.name}-{index}",
                daemon=True,
            )
            for index in range(self.diagnostics.workers)
        ]
        for thread in threads:
            thread.start()

        feeder = threading.Thread(
            target=self._feed,
            args=(items, sentinel, cancel),
            name=f"{self.diagnostics.name}-feed",
            daemon=True,
        )
        feeder.start()

        finished = 0
        while finished < self.diagnostics.workers:
            item = self._output.get()
            if item is sentinel:
                finished += 1
                continue
            yield item

        feeder.join(timeout=5)
        for thread in threads:
            thread.join(timeout=5)
        self.diagnostics.total_seconds = time.monotonic() - started

    def _feed(
        self,
        items: Iterable[T],
        sentinel: object,
        cancel: Callable[[], bool] | None,
    ) -> None:
        try:
            for item in items:
                if cancel is not None and cancel():
                    break
                # This put blocks when the stage is full. That block *is* the
                # backpressure: the producer slows to the consumer's pace.
                if self._input.full():
                    with self._lock:
                        self.diagnostics.blocked_count += 1
                self._input.put(item)
                with self._lock:
                    self.diagnostics.queued = self._input.qsize()
                    self.diagnostics.peak_queued = max(
                        self.diagnostics.peak_queued, self.diagnostics.queued
                    )
        finally:
            for _ in range(self.diagnostics.workers):
                self._input.put(sentinel)

    def _worker(self, sentinel: object, cancel: Callable[[], bool] | None) -> None:
        while True:
            item = self._input.get()
            if item is sentinel:
                self._output.put(sentinel)
                return
            if cancel is not None and cancel():
                continue
            started = time.monotonic()
            try:
                result = self.work(item)
            except Exception as exc:  # noqa: BLE001 - one bad item never ends a stage
                with self._lock:
                    self.diagnostics.failed += 1
                if self.on_error is not None:
                    self.on_error(item, exc)
                else:
                    logger.debug(
                        "Stage item failed",
                        stage=self.diagnostics.name,
                        error=str(exc),
                    )
                continue
            elapsed = time.monotonic() - started
            with self._lock:
                self.diagnostics.processed += 1
                self.diagnostics.queued = self._input.qsize()
                if elapsed >= SLOW_ITEM_SECONDS:
                    self.diagnostics.slow_items += 1
            self._output.put(result)


@dataclass
class Pipeline:
    """A named sequence of bounded stages, reported on as one thing."""

    stages: list[BoundedStage[Any, Any]] = field(default_factory=list)

    def add(self, stage: BoundedStage[Any, Any]) -> Pipeline:
        self.stages.append(stage)
        return self

    def run(
        self,
        items: Iterable[Any],
        *,
        cancel: Callable[[], bool] | None = None,
    ) -> Iterator[Any]:
        stream: Iterable[Any] = items
        for stage in self.stages:
            stream = stage.run(stream, cancel=cancel)
        yield from stream

    def diagnostics(self) -> list[dict[str, Any]]:
        return [stage.diagnostics.snapshot() for stage in self.stages]

    @property
    def bottleneck(self) -> str | None:
        """The stage everything else is waiting on, when there is one."""
        saturated = [stage for stage in self.stages if stage.diagnostics.saturated]
        if not saturated:
            return None
        return max(saturated, key=lambda stage: stage.diagnostics.blocked_count).diagnostics.name


def batched(items: Iterable[T], size: int) -> Iterator[list[T]]:
    """Group a stream into bounded lists, so writes commit in fixed chunks."""
    if size < 1:
        raise ValueError("batch size must be at least 1")
    batch: list[T] = []
    for item in items:
        batch.append(item)
        if len(batch) >= size:
            yield batch
            batch = []
    if batch:
        yield batch


@dataclass
class ResourcePressure:
    """What the pipeline should do less of, and why.

    Deliberately advisory. Nothing here kills work: it reduces concurrency and
    says so, because a paused import that finishes slowly is better than one
    that is killed by the operating system.
    """

    memory_mib: int | None = None
    limit_mib: int | None = None

    @property
    def over_limit(self) -> bool:
        return (
            self.memory_mib is not None
            and self.limit_mib is not None
            and self.memory_mib > self.limit_mib
        )

    def advice(self) -> str | None:
        if not self.over_limit:
            return None
        return (
            f"Using {self.memory_mib} MiB against a {self.limit_mib} MiB limit; "
            "reducing concurrency and batch sizes."
        )

    def adjusted(self, ceilings: ResourceCeilings) -> ResourceCeilings:
        """Halve the concurrency and depth while pressure lasts."""
        if not self.over_limit:
            return ceilings
        return ResourceCeilings(
            logical_cpus=max(1, ceilings.logical_cpus // 2),
            io_workers=None if ceilings.io_workers is None else max(1, ceilings.io_workers // 2),
            cpu_workers=None if ceilings.cpu_workers is None else max(1, ceilings.cpu_workers // 2),
            queue_depth=max(1, ceilings.depth() // 2),
            memory_limit_mib=ceilings.memory_limit_mib,
        )
