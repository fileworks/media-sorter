from pathlib import Path

import piexif
from fastapi.testclient import TestClient
from PIL import Image

from app.core.config import Config


def _photo(path: Path) -> None:
    Image.new("RGB", (24, 24), "navy").save(path, quality=95)
    exif = {
        "Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:01:02 10:00:00"},
    }
    piexif.insert(piexif.dump(exif), str(path))


def test_reviewed_reconciliation_plan_uses_standard_preflight_and_executor(
    client: TestClient,
    tmp_path: Path,
) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    _photo(source / "photo.jpg")
    container = client.app.state.container  # type: ignore[attr-defined]
    original = Config.from_dict(container.config.to_dict())
    container.set_config(
        Config(
            source_directory=str(source),
            target_directory=str(destination),
            sort_criteria=["year", "month"],
            copy_instead_of_move=True,
        )
    )
    try:
        compared = client.post(
            "/api/reconciliation/compare",
            json={"input_available": True},
        )
        assert compared.status_code == 200
        report = compared.json()
        assert report["counts"]["missing"] == 1
        assert report["next_cursor"] is None
        finding = next(item for item in report["findings"] if item["classification"] == "missing")

        planned = client.post(
            "/api/reconciliation/plan",
            json={
                "report_id": report["report_id"],
                "finding_ids": [finding["finding_id"]],
                "confirm_probable": [],
            },
        )
        assert planned.status_code == 200
        impact = planned.json()
        assert impact["action_count"] == 1
        assert impact["bytes_affected"] > 0
        assert impact["source_mutations"] == 0

        refused = client.post(
            f"/api/reconciliation/plans/{impact['plan_id']}/execute",
            json={"acknowledged": False},
        )
        assert refused.status_code == 409

        executed = client.post(
            f"/api/reconciliation/plans/{impact['plan_id']}/execute",
            json={"acknowledged": True},
        )
        assert executed.status_code == 200
        assert executed.json()["completed"] == 1
        assert (destination / "2024" / "01" / "photo.jpg").is_file()

        replayed = client.post(
            f"/api/reconciliation/plans/{impact['plan_id']}/execute",
            json={"acknowledged": True},
        )
        assert replayed.status_code == 404
    finally:
        container.set_config(original)
