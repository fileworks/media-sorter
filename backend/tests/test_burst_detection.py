from __future__ import annotations

import json
import shutil
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import piexif
import pytest
from PIL import Image, ImageDraw

import app.services.burst_detection as burst_module
from app.services.burst_detection import (
    BurstDetectionService,
    BurstSettings,
    execute_burst_quarantine,
    plan_burst_quarantine,
    quarantine_candidates,
    review_burst,
)
from app.services.duplicate_service import DuplicateRegistry, DuplicateService
from app.services.quarantine import QuarantineStore


class _FixtureHash:
    def __init__(self, value: str) -> None:
        self.value = int(value, 16)

    def __sub__(self, other: _FixtureHash) -> int:
        return (self.value ^ other.value).bit_count()


def _frame(
    path: Path,
    captured: str,
    *,
    camera: str = "Phone A",
    blurred: bool = False,
) -> None:
    image = Image.new("RGB", (96, 96), "white")
    draw = ImageDraw.Draw(image)
    for offset in range(0, 96, 8):
        draw.line((offset, 0, 95 - offset, 95), fill="black", width=2)
    image.save(path, quality=95)
    exif = {
        "0th": {
            piexif.ImageIFD.Make: b"Fixture",
            piexif.ImageIFD.Model: camera.encode(),
        },
        "Exif": {piexif.ExifIFD.DateTimeOriginal: captured.encode()},
    }
    piexif.insert(piexif.dump(exif), str(path))


def test_detection_requires_time_similarity_and_camera_and_ranks_sharpness(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    first = tmp_path / "shot-1.jpg"
    second = tmp_path / "shot-2.jpg"
    _frame(first, "2026:01:02 10:00:00", blurred=True)
    _frame(second, "2026:01:02 10:00:01")
    sidecar = tmp_path / "shot-2.xmp"
    sidecar.write_text("edit")
    service = BurstDetectionService()
    monkeypatch.setattr(
        "app.services.burst_detection._sharpness",
        lambda path: 10.0 if path == first else 100.0,
    )

    groups = service.detect(
        [first, second, sidecar],
        tmp_path,
        BurstSettings(enabled=True, max_perceptual_distance=12),
    )

    assert len(groups) == 1
    group = groups[0]
    assert service.sharpness_computations == 2
    assert group.proposed_representative_id == group.frames[1].frame_id
    assert str(sidecar) in group.frames[1].member_paths
    assert all(frame.camera_identity == "Fixture-Phone-A" for frame in group.frames)


def test_disabled_does_no_work_and_negative_signals_do_not_group(tmp_path: Path) -> None:
    first = tmp_path / "a.jpg"
    other_camera = tmp_path / "b.jpg"
    late = tmp_path / "c.jpg"
    _frame(first, "2026:01:02 10:00:00")
    _frame(other_camera, "2026:01:02 10:00:01", camera="Phone B")
    _frame(late, "2026:01:02 10:01:00")
    service = BurstDetectionService()

    assert service.detect([first, other_camera, late], tmp_path, BurstSettings()) == ()
    assert service.sharpness_computations == 0
    assert (
        service.detect(
            [first, other_camera, late],
            tmp_path,
            BurstSettings(enabled=True, max_perceptual_distance=12),
        )
        == ()
    )


def test_exact_duplicates_are_removed_before_burst_review(tmp_path: Path) -> None:
    first = tmp_path / "a.jpg"
    duplicate = tmp_path / "a-copy.jpg"
    third = tmp_path / "b.jpg"
    _frame(first, "2026:01:02 10:00:00")
    shutil.copy2(first, duplicate)
    _frame(third, "2026:01:02 10:00:01", blurred=True)
    service = BurstDetectionService()

    groups = service.detect(
        [first, duplicate, third],
        tmp_path,
        BurstSettings(enabled=True, max_perceptual_distance=12),
    )
    assert len(groups) == 1
    assert len(groups[0].frames) == 2


def test_review_can_override_keep_multiple_or_dismiss_and_never_deletes(
    tmp_path: Path,
) -> None:
    first = tmp_path / "a.jpg"
    second = tmp_path / "b.jpg"
    _frame(first, "2026:01:02 10:00:00")
    _frame(second, "2026:01:02 10:00:01", blurred=True)
    group = BurstDetectionService().detect(
        [first, second],
        tmp_path,
        BurstSettings(enabled=True, max_perceptual_distance=12),
    )[0]

    try:
        quarantine_candidates(group)
    except ValueError as exc:
        assert "before review" in str(exc)
    else:
        raise AssertionError("unreviewed burst produced actions")

    reviewed = review_burst(group, keep_frame_ids=(group.frames[1].frame_id,))
    assert quarantine_candidates(reviewed) == (group.frames[0],)
    assert first.exists() and second.exists()
    dismissed = review_burst(group, keep_frame_ids=(), dismissed=True)
    assert quarantine_candidates(dismissed) == ()


def test_reviewed_burst_uses_frozen_verified_quarantine_plan(tmp_path: Path) -> None:
    first = tmp_path / "a.jpg"
    second = tmp_path / "b.jpg"
    sidecar = tmp_path / "b.xmp"
    _frame(first, "2026:01:02 10:00:00")
    _frame(second, "2026:01:02 10:00:01")
    sidecar.write_text("edit")
    group = BurstDetectionService().detect(
        [first, second, sidecar],
        tmp_path,
        BurstSettings(enabled=True, max_perceptual_distance=12),
    )[0]
    reviewed = review_burst(group, keep_frame_ids=(group.frames[0].frame_id,))
    plan = plan_burst_quarantine(reviewed)

    assert {Path(item.path).name for item in plan.members} == {"b.jpg", "b.xmp"}
    records = execute_burst_quarantine(
        plan,
        QuarantineStore(tmp_path / "managed-quarantine"),
        operation_id="burst-test",
    )

    assert first.exists()
    assert not second.exists()
    assert not sidecar.exists()
    assert len(records) == 2
    assert all(Path(record.quarantine_path).exists() for record in records)
    assert all(record.retention == "retained" for record in records)


def test_enabling_bursts_cannot_change_duplicate_verdicts(tmp_path: Path) -> None:
    first = tmp_path / "a.jpg"
    exact_copy = tmp_path / "a-copy.jpg"
    next_frame = tmp_path / "b.jpg"
    _frame(first, "2026:01:02 10:00:00")
    shutil.copy2(first, exact_copy)
    _frame(next_frame, "2026:01:02 10:00:01")
    paths = [first, exact_copy, next_frame]

    def verdicts() -> list[tuple[bool, str | None, str | None]]:
        service = DuplicateService()
        registry = DuplicateRegistry()
        return [
            (
                match.is_duplicate,
                match.match_type,
                match.original_path,
            )
            for path in paths
            for match in [
                service.check_duplicate(
                    path,
                    registry,
                    exact=True,
                    perceptual=True,
                    threshold=95,
                )
            ]
        ]

    before = verdicts()
    BurstDetectionService().detect(
        paths,
        tmp_path,
        BurstSettings(enabled=True, max_perceptual_distance=12),
    )
    assert verdicts() == before


def test_calibration_corpus_has_zero_recorded_false_pairs(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    fixture_path = Path(__file__).parent / "fixtures" / "burst-calibration.json"
    fixture = json.loads(fixture_path.read_text(encoding="utf-8"))
    observations = fixture["observations"]
    records = {item["id"]: item for item in observations}
    paths: list[Path] = []
    for item in observations:
        path = tmp_path / f"{item['id']}.jpg"
        path.write_bytes(item["id"].encode())
        paths.append(path)

    monkeypatch.setattr(
        burst_module,
        "_capture_time",
        lambda path: datetime.fromisoformat(records[path.stem]["captured_at"]),
    )
    monkeypatch.setattr(
        burst_module,
        "stream_sha256",
        lambda path: (
            f"{int.from_bytes(path.stem.encode(), 'big'):064x}"[-64:],
            path.stat().st_size,
        ),
    )
    monkeypatch.setattr(burst_module, "_sharpness", lambda _path: 1.0)
    service = BurstDetectionService()
    monkeypatch.setattr(
        service.extraction,
        "extract_camera_model",
        lambda path: records[path.stem]["camera"],
    )
    monkeypatch.setattr(
        service.duplicate_service,
        "image_signature",
        lambda path: SimpleNamespace(phash=_FixtureHash(records[path.stem]["phash"])),
    )
    defaults = fixture["defaults"]
    settings = BurstSettings(enabled=True, **defaults)

    groups = service.detect(paths, tmp_path, settings)
    predicted = {
        tuple(sorted((left.primary_path, right.primary_path)))
        for group in groups
        for index, left in enumerate(group.frames)
        for right in group.frames[index + 1 :]
    }
    truth_groups: dict[str, list[str]] = {}
    for item in observations:
        if item["truth_burst"] is not None:
            truth_groups.setdefault(item["truth_burst"], []).append(
                str(tmp_path / f"{item['id']}.jpg")
            )
    expected = {
        tuple(sorted((left, right)))
        for members in truth_groups.values()
        for index, left in enumerate(members)
        for right in members[index + 1 :]
    }
    false_positives = predicted - expected
    false_negatives = expected - predicted
    all_pairs = len(paths) * (len(paths) - 1) // 2
    negative_pairs = all_pairs - len(expected)

    assert len(groups) == fixture["expected"]["true_groups"]
    assert len(expected) == fixture["expected"]["true_pairs"]
    assert negative_pairs == fixture["expected"]["negative_pairs"]
    assert len(false_positives) == fixture["expected"]["false_positives"] == 0
    assert len(false_negatives) == fixture["expected"]["false_negatives"] == 0
    assert settings.time_window_seconds == 3.0
    assert settings.max_perceptual_distance == 4
    assert settings.require_camera_identity
