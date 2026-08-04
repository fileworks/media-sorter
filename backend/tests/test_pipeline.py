"""Bounded stages must stay bounded, and a stalled consumer must slow a producer.

These are structural tests: they assert queue depth, worker counts, batch sizes,
and cancellation latency rather than throughput, because those are the
properties that decide whether a two-million-file library works at all.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Iterator

import pytest

from app.services.pipeline import (
    DEFAULT_QUEUE_DEPTH,
    MAX_WORKERS,
    BoundedStage,
    Pipeline,
    ResourceCeilings,
    ResourcePressure,
    batched,
)


class TestCeilings:
    def test_database_work_always_gets_exactly_one_writer(self) -> None:
        assert ResourceCeilings(logical_cpus=64).workers_for("database") == 1

    def test_io_work_gets_more_threads_than_cores_but_stays_capped(self) -> None:
        modest = ResourceCeilings(logical_cpus=4).workers_for("io_bound")
        enormous = ResourceCeilings(logical_cpus=1024).workers_for("io_bound")

        assert modest > 4 - 1
        assert enormous <= MAX_WORKERS

    def test_cpu_work_leaves_a_core_for_the_interface(self) -> None:
        assert ResourceCeilings(logical_cpus=8).workers_for("cpu_bound") == 7

    def test_an_expert_override_is_honoured_but_clamped(self) -> None:
        assert ResourceCeilings(io_workers=2).workers_for("io_bound") == 2
        assert ResourceCeilings(io_workers=10_000).workers_for("io_bound") == MAX_WORKERS

    def test_a_nonsense_override_never_produces_zero_workers(self) -> None:
        assert ResourceCeilings(cpu_workers=0, logical_cpus=1).workers_for("cpu_bound") >= 1

    def test_queue_depth_is_bounded_in_both_directions(self) -> None:
        assert ResourceCeilings().depth() == DEFAULT_QUEUE_DEPTH
        assert ResourceCeilings(queue_depth=10_000_000).depth() <= 10_000
        assert ResourceCeilings(queue_depth=0).depth() >= 1


class TestBoundedStage:
    def test_every_item_is_processed(self) -> None:
        stage = BoundedStage("double", lambda value: value * 2, ceilings=ResourceCeilings())

        results = sorted(stage.run(range(100)))

        assert results == [value * 2 for value in range(100)]
        assert stage.diagnostics.processed == 100

    def test_the_queue_never_exceeds_its_declared_depth(self) -> None:
        ceilings = ResourceCeilings(queue_depth=4, io_workers=1)
        stage = BoundedStage("slow", lambda value: (time.sleep(0.002), value)[1], ceilings=ceilings)

        list(stage.run(range(200)))

        assert stage.diagnostics.peak_queued <= 4

    def test_a_slow_consumer_makes_the_producer_wait(self) -> None:
        ceilings = ResourceCeilings(queue_depth=2, io_workers=1)
        stage = BoundedStage("slow", lambda value: (time.sleep(0.005), value)[1], ceilings=ceilings)

        list(stage.run(range(50)))

        assert stage.diagnostics.blocked_count > 0
        assert stage.diagnostics.saturated is True

    def test_one_failing_item_does_not_end_the_stage(self) -> None:
        def work(value: int) -> int:
            if value == 5:
                raise ValueError("bad item")
            return value

        failures: list[int] = []
        stage = BoundedStage("flaky", work, on_error=lambda item, _exc: failures.append(item))

        results = sorted(stage.run(range(10)))

        assert results == [value for value in range(10) if value != 5]
        assert failures == [5]
        assert stage.diagnostics.failed == 1

    def test_cancellation_stops_promptly_and_reports_it(self) -> None:
        cancelled = threading.Event()

        def work(value: int) -> int:
            if value > 10:
                cancelled.set()
            time.sleep(0.001)
            return value

        stage = BoundedStage(
            "cancellable",
            work,
            ceilings=ResourceCeilings(queue_depth=4, io_workers=2),
        )

        started = time.monotonic()
        results = list(stage.run(range(100_000), cancel=cancelled.is_set))
        elapsed = time.monotonic() - started

        assert len(results) < 100_000
        assert elapsed < 10  # it stopped, rather than draining the whole input

    def test_slow_items_are_counted_without_being_failures(self) -> None:
        stage = BoundedStage(
            "occasionally-slow",
            lambda value: (time.sleep(2.01 if value == 0 else 0), value)[1],
            ceilings=ResourceCeilings(io_workers=1),
        )

        list(stage.run(range(2)))

        assert stage.diagnostics.slow_items == 1
        assert stage.diagnostics.failed == 0

    def test_diagnostics_are_renderable_without_stopping_anything(self) -> None:
        stage = BoundedStage("simple", lambda value: value)

        list(stage.run(range(5)))
        snapshot = stage.diagnostics.snapshot()

        assert snapshot["processed"] == 5
        assert snapshot["workers"] >= 1
        assert "throughput_per_second" in snapshot


class TestPipeline:
    def test_stages_compose_and_stay_bounded(self) -> None:
        ceilings = ResourceCeilings(queue_depth=8, io_workers=2, cpu_workers=2)
        pipeline = (
            Pipeline()
            .add(BoundedStage("parse", lambda value: value + 1, ceilings=ceilings))
            .add(
                BoundedStage(
                    "hash", lambda value: value * 2, workload="cpu_bound", ceilings=ceilings
                )
            )
        )

        results = sorted(pipeline.run(range(100)))

        assert results == sorted((value + 1) * 2 for value in range(100))
        assert all(stage["peak_queued"] <= 8 for stage in pipeline.diagnostics())

    def test_the_bottleneck_is_named(self) -> None:
        fast = ResourceCeilings(queue_depth=64, io_workers=4)
        slow = ResourceCeilings(queue_depth=2, io_workers=1)
        pipeline = (
            Pipeline()
            .add(BoundedStage("fast", lambda value: value, ceilings=fast))
            .add(BoundedStage("slow", lambda value: (time.sleep(0.004), value)[1], ceilings=slow))
        )

        list(pipeline.run(range(60)))

        assert pipeline.bottleneck == "slow"

    def test_an_idle_pipeline_reports_no_bottleneck(self) -> None:
        pipeline = Pipeline().add(BoundedStage("trivial", lambda value: value))

        list(pipeline.run(range(3)))

        assert pipeline.bottleneck is None


class TestBatching:
    def test_batches_are_exactly_the_requested_size_until_the_last(self) -> None:
        batches = list(batched(range(10), 4))

        assert [len(batch) for batch in batches] == [4, 4, 2]

    def test_an_empty_stream_produces_no_batches(self) -> None:
        assert list(batched([], 5)) == []

    def test_a_zero_batch_size_is_refused(self) -> None:
        with pytest.raises(ValueError):
            list(batched(range(3), 0))

    def test_batching_never_materializes_the_whole_stream(self) -> None:
        seen = 0

        def counting() -> Iterator[object]:
            nonlocal seen
            for value in range(1_000_000):
                seen += 1
                yield value

        first = next(batched(counting(), 10))

        assert len(first) == 10
        assert seen == 10  # the generator was not drained to build one batch


class TestResourcePressure:
    def test_no_pressure_changes_nothing(self) -> None:
        ceilings = ResourceCeilings(logical_cpus=8)

        assert ResourcePressure().adjusted(ceilings) == ceilings
        assert ResourcePressure().advice() is None

    def test_pressure_halves_concurrency_and_says_so(self) -> None:
        pressure = ResourcePressure(memory_mib=900, limit_mib=512)
        adjusted = pressure.adjusted(ResourceCeilings(logical_cpus=8, queue_depth=400))

        assert pressure.over_limit is True
        assert adjusted.logical_cpus == 4
        assert adjusted.queue_depth == 200
        assert "reducing concurrency" in (pressure.advice() or "")

    def test_pressure_never_reduces_below_one(self) -> None:
        adjusted = ResourcePressure(memory_mib=10, limit_mib=1).adjusted(
            ResourceCeilings(logical_cpus=1, io_workers=1, queue_depth=1)
        )

        assert adjusted.logical_cpus == 1
        assert adjusted.workers_for("io_bound") >= 1
