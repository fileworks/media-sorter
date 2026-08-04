"""Baselines for the storage tiers a real library actually lives on.

Four tiers, each a different failure mode rather than a different speed: a fast
local disk, a machine short of memory, a spinning disk whose seeks dominate, and
a network share that intermittently stops answering. The assertions are about
*behaviour under* each tier — bounded memory, honest partial results, no silent
pruning — because the timings belong to whoever's hardware is running them.

Latency is injected rather than measured, so these run in seconds and produce
the same result on any machine.
"""

from __future__ import annotations

import time
from collections.abc import Iterator
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import pytest

from app.services.catalog import MediaCatalog
from app.services.discovery import DiscoveryStats, TraversalRules, discover_into_catalog, walk
from app.services.pipeline import BoundedStage, ResourceCeilings, ResourcePressure


@dataclass(frozen=True)
class Tier:
    """One storage profile, described by what it does to a caller."""

    name: str
    #: Seconds added to each filesystem operation.
    latency: float
    #: Every Nth operation fails, simulating a share that drops. Zero disables.
    failure_every: int
    ceilings: ResourceCeilings

    def budget_bytes(self) -> int:
        limit = self.ceilings.memory_limit_mib
        return (limit or 512) * 1024 * 1024


TIERS = (
    Tier("ssd", 0.0, 0, ResourceCeilings(logical_cpus=8, queue_depth=500)),
    Tier(
        "constrained-memory",
        0.0,
        0,
        ResourceCeilings(logical_cpus=2, queue_depth=16, memory_limit_mib=128),
    ),
    Tier("hdd", 0.0005, 0, ResourceCeilings(logical_cpus=4, io_workers=2, queue_depth=64)),
    Tier(
        "network-fault", 0.0002, 7, ResourceCeilings(logical_cpus=4, io_workers=4, queue_depth=64)
    ),
)

TIER_BY_NAME = {tier.name: tier for tier in TIERS}


def build_library(root: Path, *, files: int = 200, depth: int = 3) -> Path:
    """A generated tree, never a committed fixture."""
    root.mkdir(parents=True, exist_ok=True)
    for index in range(files):
        directory = root
        for level in range(index % depth):
            directory = directory / f"level{level}"
        directory.mkdir(parents=True, exist_ok=True)
        (directory / f"{index:04}.jpg").write_bytes(b"x" * (64 + index % 97))
    return root


@pytest.fixture(params=[tier.name for tier in TIERS])
def tier(request: pytest.FixtureRequest) -> Tier:
    return TIER_BY_NAME[request.param]


class _Flaky:
    """A work function that stalls, and on the fault tier sometimes refuses."""

    def __init__(self, tier: Tier) -> None:
        self.tier = tier
        self.calls = 0
        self.failures = 0

    def __call__(self, value: int) -> int:
        self.calls += 1
        if self.tier.latency:
            time.sleep(self.tier.latency)
        if self.tier.failure_every and self.calls % self.tier.failure_every == 0:
            self.failures += 1
            raise OSError("the share stopped answering")
        return value


class TestTierBaselines:
    def test_every_tier_processes_what_it_can_and_reports_the_rest(self, tier: Tier) -> None:
        work = _Flaky(tier)
        stage = BoundedStage("scan", work, ceilings=tier.ceilings)

        results = list(stage.run(range(120)))

        assert len(results) == 120 - work.failures
        assert stage.diagnostics.failed == work.failures
        # A tier that drops operations must say so rather than look complete.
        if tier.failure_every:
            assert stage.diagnostics.failed > 0

    def test_the_queue_stays_inside_the_tier_budget(self, tier: Tier) -> None:
        stage = BoundedStage("scan", _Flaky(tier), ceilings=tier.ceilings)

        list(stage.run(range(200)))

        assert stage.diagnostics.peak_queued <= tier.ceilings.depth()

    def test_a_constrained_tier_uses_fewer_workers_than_a_fast_one(self) -> None:
        constrained = TIER_BY_NAME["constrained-memory"].ceilings.workers_for("cpu_bound")
        fast = TIER_BY_NAME["ssd"].ceilings.workers_for("cpu_bound")

        assert constrained < fast

    def test_memory_pressure_halves_the_tier_rather_than_failing(self, tier: Tier) -> None:
        pressure = ResourcePressure(
            memory_mib=4096, limit_mib=tier.ceilings.memory_limit_mib or 512
        )

        adjusted = pressure.adjusted(tier.ceilings)

        assert adjusted.depth() <= tier.ceilings.depth()
        assert adjusted.workers_for("io_bound") >= 1
        assert "reducing concurrency" in (pressure.advice() or "")

    def test_cancellation_is_honoured_on_every_tier(self, tier: Tier) -> None:
        stage = BoundedStage("scan", _Flaky(tier), ceilings=tier.ceilings)
        seen = {"count": 0}

        def cancel() -> bool:
            seen["count"] += 1
            return seen["count"] > 20

        results = list(stage.run(range(5_000), cancel=cancel))

        assert len(results) < 5_000


class TestDiscoveryUnderTiers:
    def test_a_generated_library_is_fully_discovered_on_a_healthy_tier(
        self, tmp_path: Path
    ) -> None:
        root = build_library(tmp_path / "library", files=120)
        stats = DiscoveryStats()

        found = list(walk(root, TraversalRules(), stats))

        assert len(found) == 120
        assert stats.outcome == "complete"

    def test_a_faulting_tier_produces_a_partial_scan_that_never_prunes(
        self, tmp_path: Path
    ) -> None:
        root = build_library(tmp_path / "library", files=40)
        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", root, role="input")
            discover_into_catalog(catalog, "r1", root)
            before = sum(1 for _ in catalog.iter_files("r1"))

            # A share that drops mid-walk: the traversal stops early and the
            # generation is not complete, so nothing may be marked missing.
            stats = discover_into_catalog(catalog, "r1", root, cancel=_after_calls(5))

            assert stats.outcome == "cancelled"
            assert sum(1 for _ in catalog.iter_files("r1")) == before

    def test_repeated_runs_on_an_unchanged_library_reuse_their_work(self, tmp_path: Path) -> None:
        root = build_library(tmp_path / "library", files=60)
        with MediaCatalog(tmp_path / "catalog.db") as catalog:
            catalog.register_root("r1", root, role="input")
            discover_into_catalog(catalog, "r1", root)
            first = next(iter(catalog.iter_files("r1")))
            catalog.store_hash(first, "a" * 64)

            discover_into_catalog(catalog, "r1", root)

            assert catalog.hash_for(next(iter(catalog.iter_files("r1")))) == "a" * 64


def _after_calls(limit: int) -> Any:
    state = {"count": 0}

    def cancel() -> bool:
        state["count"] += 1
        return state["count"] > limit

    return cancel


@pytest.fixture()
def tiers_report() -> Iterator[None]:
    """Kept as a hook for publishing tier results alongside the benchmark run."""
    yield
