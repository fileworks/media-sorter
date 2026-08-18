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

from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.core.config import Config
from app.core.sort_plan import FrozenSortPlan, build_frozen_sort_plan


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
