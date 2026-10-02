"""C-04: a plan is stale when the *destination* moved, not only the settings.

The freshness check compared `config_fingerprint` and nothing else. That answers
"did the user change the settings?" — and a file appearing in the destination
after the preview changes neither the settings nor the source. So the plan looked
fresh, the run started, and that one file failed mid-execution with a per-file
`destination_exists` report.

The destination is half of what a sort plan is about. Staleness has to mean both
halves, and it has to be answered before a run begins rather than during it.
"""

from __future__ import annotations

import os
import socket
import tempfile
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Config
from app.core.sort_plan import FrozenSortPlan, build_frozen_sort_plan, destination_fingerprint


def _plan(tmp_path: Path, *, generation: int) -> FrozenSortPlan:
    source = tmp_path / "source"
    source.mkdir(exist_ok=True)
    (source / "a.jpg").write_bytes(b"a")
    config = Config(source_directory=str(source), target_directory=str(tmp_path / "target"))
    items: list[dict[str, object]] = [
        {
            "source": str(source / "a.jpg"),
            "destination": str(tmp_path / "target" / "2024" / "a.jpg"),
            "status": "sort",
            "file_size": 1,
        }
    ]
    return build_frozen_sort_plan(items, config, catalog_generation=generation)


def test_destination_evidence_covers_add_rewrite_delete_and_rename(tmp_path: Path) -> None:
    destination = tmp_path / "target"
    destination.mkdir()
    original = destination / "original.jpg"
    original.write_bytes(b"one")
    baseline = destination_fingerprint(destination)

    added = destination / "added.jpg"
    added.write_bytes(b"two")
    assert destination_fingerprint(destination) != baseline
    added.unlink()

    original.write_bytes(b"rewritten")
    assert destination_fingerprint(destination) != baseline
    original.write_bytes(b"one")

    original.unlink()
    assert destination_fingerprint(destination) != baseline
    original.write_bytes(b"one")

    original.rename(destination / "renamed.jpg")
    assert destination_fingerprint(destination) != baseline


@pytest.mark.skipif(os.name == "nt" or not hasattr(socket, "AF_UNIX"), reason="Unix nodes only")
def test_destination_evidence_distinguishes_special_node_types() -> None:
    # Darwin limits AF_UNIX names to 104 bytes; pytest's nested temp root can be
    # longer than that before the socket's own name is appended.
    with tempfile.TemporaryDirectory(prefix="msfp-", dir="/tmp") as temporary:
        destination = Path(temporary)
        special = destination / "special"
        os.mkfifo(special)
        fifo = destination_fingerprint(destination)
        special.unlink()
        server = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        try:
            server.bind(str(special))
            assert destination_fingerprint(destination) != fifo
        finally:
            server.close()
            special.unlink(missing_ok=True)


@pytest.mark.skipif(os.name == "nt", reason="Unix nodes only")
def test_destination_evidence_distinguishes_same_kind_special_node_replacement(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "target"
    destination.mkdir()
    special = destination / "special"
    replacement = tmp_path / "replacement"
    os.mkfifo(special)
    os.mkfifo(replacement)
    assert special.stat().st_ino != replacement.stat().st_ino
    baseline = destination_fingerprint(destination)

    special.unlink()
    replacement.rename(special)

    assert destination_fingerprint(destination) != baseline


def test_destination_evidence_includes_empty_directory_add_delete_and_rename(
    tmp_path: Path,
) -> None:
    destination = tmp_path / "target"
    destination.mkdir()
    baseline = destination_fingerprint(destination)
    empty = destination / "planned-file.jpg"

    empty.mkdir()
    added = destination_fingerprint(destination)
    assert added != baseline

    empty.rename(destination / "renamed-empty")
    assert destination_fingerprint(destination) != added

    (destination / "renamed-empty").rmdir()
    assert destination_fingerprint(destination) == baseline


class TestThePlanCarriesTheGeneration:
    def test_a_built_plan_records_the_generation_it_saw(self, tmp_path: Path) -> None:
        assert _plan(tmp_path, generation=7).catalog_generation == 7

    def test_a_plan_built_without_one_records_zero(self, tmp_path: Path) -> None:
        """Zero is the honest answer for a library with no catalog."""
        source = tmp_path / "source"
        source.mkdir()
        (source / "a.jpg").write_bytes(b"a")
        config = Config(source_directory=str(source), target_directory=str(tmp_path / "target"))

        plan = build_frozen_sort_plan([], config)

        assert plan.catalog_generation == 0

    def test_the_field_survives_a_round_trip(self, tmp_path: Path) -> None:
        """It is persisted with the plan, so a restart still knows (P0-SAFE-004)."""
        plan = _plan(tmp_path, generation=3)

        restored = FrozenSortPlan.model_validate(plan.model_dump(mode="json"))

        assert restored.catalog_generation == 3

    def test_a_plan_from_before_this_field_still_validates(self, tmp_path: Path) -> None:
        """Refusing every older plan would be worse than the defect this prevents."""
        payload = _plan(tmp_path, generation=5).model_dump(mode="json")
        del payload["catalog_generation"]

        restored = FrozenSortPlan.model_validate(payload)

        assert restored.catalog_generation == 0


class TestTheStartRouteRefusesAStalePlan:
    def _start(self, client: TestClient, plan_id: str) -> object:
        return client.post("/api/sorting/start", json={"dry_run": False, "plan_id": plan_id})

    def _live_plan(self, client: TestClient, *, generation: int) -> FrozenSortPlan:
        """A plan whose config fingerprint matches the running container's.

        Otherwise the configuration check fires first, and this suite would be
        asserting `stale_plan` while believing it asserted `stale_catalog`.
        """
        container = client.app.state.container  # type: ignore[attr-defined]
        return build_frozen_sort_plan([], container.config, catalog_generation=generation)

    def test_a_generation_change_is_refused_before_the_run_begins(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        container = client.app.state.container  # type: ignore[attr-defined]
        plan = self._live_plan(client, generation=1)
        monkeypatch.setattr(container.preview_service, "frozen_plan", lambda _id: plan)
        monkeypatch.setattr("app.api.routes.sorting.live_catalog_generation", lambda _container: 2)

        response = self._start(client, plan.plan_id)

        assert response.status_code == 409  # type: ignore[attr-defined]
        details = response.json()["details"]  # type: ignore[attr-defined]
        assert details["reason"] == "stale_catalog"
        assert details["plan_catalog_generation"] == 1
        assert details["current_catalog_generation"] == 2

    def test_an_unchanged_generation_is_not_refused_for_that_reason(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        container = client.app.state.container  # type: ignore[attr-defined]
        plan = self._live_plan(client, generation=1)
        monkeypatch.setattr(container.preview_service, "frozen_plan", lambda _id: plan)
        monkeypatch.setattr("app.api.routes.sorting.live_catalog_generation", lambda _container: 1)

        response = self._start(client, plan.plan_id)

        payload = response.json()  # type: ignore[attr-defined]
        assert payload.get("details", {}).get("reason") != "stale_catalog"

    def test_a_plan_recording_no_generation_is_not_refused(
        self, client: TestClient, monkeypatch: pytest.MonkeyPatch, tmp_path: Path
    ) -> None:
        """Plans predating this field must keep working."""
        container = client.app.state.container  # type: ignore[attr-defined]
        plan = self._live_plan(client, generation=0)
        monkeypatch.setattr(container.preview_service, "frozen_plan", lambda _id: plan)
        monkeypatch.setattr("app.api.routes.sorting.live_catalog_generation", lambda _container: 9)

        response = self._start(client, plan.plan_id)

        payload = response.json()  # type: ignore[attr-defined]
        assert payload.get("details", {}).get("reason") != "stale_catalog"

    @pytest.mark.parametrize("mutation", ["add", "rewrite", "delete", "rename"])
    def test_real_destination_mutations_are_refused_before_task_creation(
        self,
        client: TestClient,
        monkeypatch: pytest.MonkeyPatch,
        mutation: str,
    ) -> None:
        container = client.app.state.container  # type: ignore[attr-defined]
        destination = Path(container.config.target_directory)
        destination.mkdir(parents=True, exist_ok=True)
        original = destination / f"freshness-{mutation}.jpg"
        original.write_bytes(b"reviewed")
        plan = self._live_plan(client, generation=0)
        monkeypatch.setattr(container.preview_service, "frozen_plan", lambda _id: plan)

        if mutation == "add":
            (destination / f"added-{mutation}.jpg").write_bytes(b"new")
        elif mutation == "rewrite":
            original.write_bytes(b"changed")
        elif mutation == "delete":
            original.unlink()
        else:
            original.rename(destination / f"renamed-{mutation}.jpg")

        response = self._start(client, plan.plan_id)

        assert response.status_code == 409  # type: ignore[attr-defined]
        assert response.json()["details"]["reason"] == "stale_destination"  # type: ignore[attr-defined]
