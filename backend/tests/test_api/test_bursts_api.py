from pathlib import Path
from types import SimpleNamespace

import piexif
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.core.config import Config


def _frame(path: Path, captured: str) -> None:
    image = Image.new("RGB", (96, 96), "white")
    draw = ImageDraw.Draw(image)
    for offset in range(0, 96, 8):
        draw.line((offset, 0, 95 - offset, 95), fill="black", width=2)
    image.save(path, quality=95)
    exif = {
        "0th": {
            piexif.ImageIFD.Make: b"Fixture",
            piexif.ImageIFD.Model: b"Camera",
        },
        "Exif": {piexif.ExifIFD.DateTimeOriginal: captured.encode()},
    }
    piexif.insert(piexif.dump(exif), str(path))


def test_burst_plan_requires_preflight_and_persists_exportable_report(
    client: TestClient,
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    state_root = tmp_path / "state"
    monkeypatch.setattr(
        "app.api.routes.bursts.resolve_app_paths",
        lambda: SimpleNamespace(data_dir=state_root),
    )
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    source.mkdir()
    destination.mkdir()
    first = source / "a.jpg"
    second = source / "b.jpg"
    _frame(first, "2026:01:02 10:00:00")
    _frame(second, "2026:01:02 10:00:01")
    container = client.app.state.container  # type: ignore[attr-defined]
    original = Config.from_dict(container.config.to_dict())
    configured = Config(
        source_directory=str(source),
        target_directory=str(destination),
        copy_instead_of_move=True,
        burst_detection_enabled=True,
        burst_time_window_seconds=3,
        burst_perceptual_distance=12,
        burst_require_camera_identity=True,
    )
    container.set_config(configured)
    try:
        detected = client.post(
            "/api/review/bursts/detect",
            json={"root": str(source), "paths": [str(first), str(second)]},
        )
        assert detected.status_code == 200
        group = detected.json()[0]
        decided = client.post(
            "/api/review/bursts/decision",
            json={
                "group": group,
                "keep_frame_ids": [group["frames"][0]["frame_id"]],
                "dismissed": False,
            },
        )
        assert decided.status_code == 200
        decision = decided.json()
        assert decision["impact"]["quarantine_count"] == 1
        plan_id = decision["plan"]["plan_id"]

        refused = client.post(
            f"/api/review/bursts/plans/{plan_id}/execute",
            json={"acknowledged": False},
        )
        assert refused.status_code == 409
        executed = client.post(
            f"/api/review/bursts/plans/{plan_id}/execute",
            json={"acknowledged": True},
        )
        assert executed.status_code == 200
        report = executed.json()
        assert len(report["quarantined"]) == 1
        assert first.exists()
        assert not second.exists()

        fetched = client.get(
            f"/api/review/bursts/reports/{report['operation_id']}",
        )
        assert fetched.status_code == 200
        assert fetched.json()["group_id"] == group["group_id"]
        exported = client.post(
            f"/api/review/bursts/reports/{report['operation_id']}/export",
            json={"format": "csv"},
        )
        assert exported.status_code == 200
        assert "frame_id,unit_id,original_path,quarantine_path" in exported.text
    finally:
        container.set_config(original)
