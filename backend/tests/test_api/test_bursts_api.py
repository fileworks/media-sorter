from pathlib import Path
from types import SimpleNamespace

import piexif
import pytest
from fastapi.testclient import TestClient
from PIL import Image, ImageDraw

from app.core.config import Config
from app.services.burst_detection import BurstSettings


def _settings(*, enabled: bool) -> BurstSettings:
    """The detection settings the removed `/detect` route used to assemble."""
    return BurstSettings(
        enabled=enabled,
        time_window_seconds=3,
        max_perceptual_distance=12,
        require_camera_identity=True,
    )


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
        # `/review/bursts/detect` is gone — nothing in the app ever called it.
        # The decision → plan → execute → report flow below is what this test is
        # about, so the group it needs comes straight from the service.
        detected = container.burst_detection_service.detect(
            [first, second], source, _settings(enabled=True)
        )
        group = list(detected)[0].model_dump(mode="json")
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


def test_detection_honors_the_stored_burst_setting(
    client: TestClient,
    tmp_path: Path,
) -> None:
    """`burst_detection_enabled` gates detection itself, not just the UI control.

    `W0-UI-001` hid the burst control and stopped the catalog-backed Review path
    from asking for burst stacks, because nothing in production wrote the
    signatures and media facts that path reads. `P2-DEDUP-D3` landed that
    producer and `P2-DEDUP-D9` re-enabled the control, so what matters now is
    that the setting still decides — a frontend gate must never be mistaken for
    a backend one.

    This used to go through `POST /review/bursts/detect`. That route was removed
    as unreachable (no caller in the app, no client in the frontend), so the
    contract is asserted against the service the route wrapped.
    """
    source = tmp_path / "input"
    source.mkdir()
    first = source / "a.jpg"
    second = source / "b.jpg"
    _frame(first, "2026:01:02 10:00:00")
    _frame(second, "2026:01:02 10:00:01")

    container = client.app.state.container  # type: ignore[attr-defined]
    service = container.burst_detection_service

    assert list(service.detect([first, second], source, _settings(enabled=False))) == []

    groups = list(service.detect([first, second], source, _settings(enabled=True)))
    assert len(groups) == 1
    assert len(groups[0].frames) == 2
