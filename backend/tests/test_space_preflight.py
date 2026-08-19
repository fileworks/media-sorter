"""C-07: a run that cannot fit must be refused before it moves anything.

`quarantine.preflight()` existed and had no caller anywhere in `app/`. A run
whose destination could not hold it therefore started, moved files, and failed
part-way through — the worst possible moment, because by then half the library
has already been relocated and the user has to reason about a partial state.

Two volumes are involved and the plan's totals do not distinguish them. The
destination receives the copies, the converted outputs, and the
`_duplicates`/`_corrupted` folders that `quarantine_dir()` builds *under the
destination root*. The quarantine store receives the originals that conversion
replaced, and it lives under the app data directory — which, whenever the
destination is a NAS or an external drive, is a different device.

Summing both against one root passes a run that cannot finish. Checking each
root in isolation double-counts when they happen to share a device. So the
budget is grouped by `st_dev`.
"""

from __future__ import annotations

import shutil
from collections.abc import Iterator
from pathlib import Path
from typing import Any, NamedTuple

import pytest
from fastapi.testclient import TestClient

from app.core.sort_plan import build_frozen_sort_plan
from app.services.quarantine import preflight


class _Usage(NamedTuple):
    """What `preflight` reads from `shutil.disk_usage` — only `free` matters."""

    total: int
    used: int
    free: int


def _free_space(mapping: dict[Path, int], default: int) -> Any:
    """A `disk_usage` that reports a different free figure per directory tree."""
    real = shutil.disk_usage

    def _fake(path: Any) -> Any:
        resolved = Path(path).resolve()
        for root, free in mapping.items():
            if resolved == root.resolve() or root.resolve() in resolved.parents:
                return _Usage(total=free * 2, used=free, free=free)
        if default < 0:
            return real(resolved)
        return _Usage(total=default * 2, used=default, free=default)

    return _fake


class _Stat:
    """A stat result with an overridden `st_dev`, proxying everything else."""

    def __init__(self, real: Any, device: int) -> None:
        self._real = real
        self.st_dev = device

    def __getattr__(self, name: str) -> Any:
        return getattr(self._real, name)


def _separate_devices(mapping: dict[Path, int], monkeypatch: pytest.MonkeyPatch) -> None:
    """Report the given trees as distinct devices.

    A test cannot mount a second filesystem, and both temp roots really do share
    one `st_dev` — which the same-device tests below rely on and measure. This
    fakes only the device *number*, so the grouping logic is exercised exactly
    as it would be against a real NAS destination.
    """
    real = Path.stat

    def _stat(self: Path, *args: Any, **kwargs: Any) -> Any:
        result = real(self, *args, **kwargs)
        resolved = self.resolve()
        for root, device in mapping.items():
            if resolved == root.resolve() or root.resolve() in resolved.parents:
                return _Stat(result, device)
        return result

    monkeypatch.setattr(Path, "stat", _stat)


@pytest.fixture()
def roots(tmp_path: Path) -> Iterator[tuple[Path, Path]]:
    destination = tmp_path / "destination"
    store = tmp_path / "appdata" / "quarantine"
    destination.mkdir(parents=True)
    store.mkdir(parents=True)
    yield destination, store


class TestPerVolumeBudget:
    def test_a_short_destination_is_refused(
        self, roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        destination, store = roots
        _separate_devices({destination: 101, store: 202}, monkeypatch)
        monkeypatch.setattr(
            shutil, "disk_usage", _free_space({destination: 1_000, store: 10**12}, -1)
        )

        result = preflight(
            destination_bytes=10_000,
            quarantine_bytes=0,
            destination=destination,
            quarantine_root=store,
        )

        assert result.ready is False
        assert any("free space" in reason for reason in result.blocked_reasons)

    def test_a_short_quarantine_store_is_refused_even_when_the_destination_is_huge(
        self, roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The case a single-volume check cannot see.

        The destination has room for everything; the app-data volume that holds
        the conversion originals does not. Before this was per-volume, the run
        was cleared to start.
        """
        destination, store = roots
        _separate_devices({destination: 101, store: 202}, monkeypatch)
        monkeypatch.setattr(
            shutil, "disk_usage", _free_space({destination: 10**12, store: 1_000}, -1)
        )

        result = preflight(
            destination_bytes=10_000,
            quarantine_bytes=10_000,
            destination=destination,
            quarantine_root=store,
        )

        assert result.ready is False
        assert any(str(store) in reason for reason in result.blocked_reasons), (
            f"the short volume was not named: {result.blocked_reasons}"
        )

    def test_both_volumes_with_room_are_ready(
        self, roots: tuple[Path, Path], monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """The guard against refusing everything, which would also 'pass' above."""
        destination, store = roots
        _separate_devices({destination: 101, store: 202}, monkeypatch)
        monkeypatch.setattr(
            shutil, "disk_usage", _free_space({destination: 10**12, store: 10**12}, -1)
        )

        result = preflight(
            destination_bytes=10_000,
            quarantine_bytes=10_000,
            destination=destination,
            quarantine_root=store,
        )

        assert result.ready is True, result.blocked_reasons

    def test_two_roots_on_one_device_share_a_single_budget(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Same device: the demands add up, and there is one volume, not two.

        Both roots are under `tmp_path`, so they genuinely share `st_dev` — the
        grouping is measured, not simulated.
        """
        destination = tmp_path / "destination"
        store = tmp_path / "store"
        destination.mkdir()
        store.mkdir()
        monkeypatch.setattr(shutil, "disk_usage", _free_space({tmp_path: 15_000}, -1))

        result = preflight(
            destination_bytes=6_000,
            quarantine_bytes=6_000,
            destination=destination,
            quarantine_root=store,
        )

        assert len(result.volumes) == 1, "two roots on one device were budgeted separately"
        # 12,000 * 1.25 margin = 15,000, which exactly equals the free space.
        assert result.volumes[0].required_bytes == 15_000
        assert result.ready is True

    def test_the_same_device_sum_is_what_makes_it_fail(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Neither demand alone exceeds the free space; together they do."""
        destination = tmp_path / "destination"
        store = tmp_path / "store"
        destination.mkdir()
        store.mkdir()
        monkeypatch.setattr(shutil, "disk_usage", _free_space({tmp_path: 10_000}, -1))

        result = preflight(
            destination_bytes=6_000,
            quarantine_bytes=6_000,
            destination=destination,
            quarantine_root=store,
        )

        assert result.ready is False
        assert len(result.volumes) == 1


class TestTheStartRouteRefusesARunThatCannotFit:
    """The acceptance criterion: 409 before any file moves."""

    def _plan(self, client: TestClient, tmp_path: Path) -> Any:
        """A plan whose fingerprint matches the container, carrying real bytes.

        Built against the container's own config so the configuration check does
        not fire first — otherwise this suite would assert `insufficient_space`
        while actually observing `stale_plan`.
        """
        container = client.app.state.container  # type: ignore[attr-defined]
        source = Path(container.config.source_directory)
        source.mkdir(parents=True, exist_ok=True)
        (source / "big.jpg").write_bytes(b"x" * 64)
        items: list[dict[str, object]] = [
            {
                "source": str(source / "big.jpg"),
                "destination": str(Path(container.config.target_directory) / "2024" / "big.jpg"),
                "status": "sort",
                "file_size": 10_000_000,
            }
        ]
        return build_frozen_sort_plan(items, container.config, catalog_generation=0)

    def test_a_run_that_does_not_fit_is_refused_and_moves_nothing(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        container = client.app.state.container  # type: ignore[attr-defined]
        plan = self._plan(client, tmp_path)
        monkeypatch.setattr(container.preview_service, "frozen_plan", lambda _id: plan)
        monkeypatch.setattr(shutil, "disk_usage", _free_space({}, 1_000))

        source_file = Path(container.config.source_directory) / "big.jpg"
        assert source_file.is_file()

        response = client.post(
            "/api/sorting/start", json={"dry_run": False, "plan_id": plan.plan_id}
        )

        assert response.status_code == 409
        details = response.json()["details"]
        assert details["reason"] == "insufficient_space"
        assert details["volumes"], "the refusal must say which volume was short"
        # Nothing may have been touched: the check runs before the task starts.
        assert source_file.is_file()
        assert source_file.read_bytes() == b"x" * 64

    def test_a_run_that_fits_is_not_refused_for_space(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """The guard against a check that refuses everything."""
        container = client.app.state.container  # type: ignore[attr-defined]
        plan = self._plan(client, tmp_path)
        monkeypatch.setattr(container.preview_service, "frozen_plan", lambda _id: plan)
        monkeypatch.setattr(shutil, "disk_usage", _free_space({}, 10**14))

        response = client.post(
            "/api/sorting/start", json={"dry_run": False, "plan_id": plan.plan_id}
        )

        payload = response.json()
        assert payload.get("details", {}).get("reason") != "insufficient_space"

    def test_a_dry_run_is_never_refused_for_space(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """A dry run writes nothing, so it has nothing to budget for."""
        container = client.app.state.container  # type: ignore[attr-defined]
        plan = self._plan(client, tmp_path)
        monkeypatch.setattr(container.preview_service, "frozen_plan", lambda _id: plan)
        monkeypatch.setattr(shutil, "disk_usage", _free_space({}, 1))

        response = client.post(
            "/api/sorting/start", json={"dry_run": True, "plan_id": plan.plan_id}
        )

        payload = response.json()
        assert payload.get("details", {}).get("reason") != "insufficient_space"
