from __future__ import annotations

import shutil
from pathlib import Path

import piexif
import pytest
from PIL import Image

import app.services.destination_reconciliation as reconciliation_module
from app.core.config import Config
from app.services.catalog_views import CursorError
from app.services.destination_reconciliation import DestinationReconciliationService
from app.services.verified_transfer import execute_transfer


def _photo(path: Path, captured: str = "2024:01:02 10:00:00") -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (24, 24), "navy").save(path, quality=95)
    exif = {
        "0th": {
            piexif.ImageIFD.Make: b"Fixture",
            piexif.ImageIFD.Model: b"Camera",
        },
        "Exif": {piexif.ExifIFD.DateTimeOriginal: captured.encode()},
    }
    piexif.insert(piexif.dump(exif), str(path))


def _config(source: Path, destination: Path) -> Config:
    return Config(
        source_directory=str(source),
        target_directory=str(destination),
        sort_criteria=["year", "month"],
        copy_instead_of_move=True,
    )


def test_reconciliation_classifies_matched_missing_misplaced_and_inert_extra(
    tmp_path: Path,
) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    matched = source / "matched.jpg"
    missing = source / "missing.jpg"
    misplaced = source / "misplaced.jpg"
    _photo(matched)
    _photo(missing)
    _photo(misplaced)
    correct = destination / "2024" / "01"
    correct.mkdir(parents=True)
    shutil.copy2(matched, correct / matched.name)
    wrong = destination / "old-layout"
    wrong.mkdir()
    shutil.copy2(misplaced, wrong / misplaced.name)
    extra = destination / "extra.jpg"
    _photo(extra, "2023:02:01 00:00:00")
    service = DestinationReconciliationService()

    report = service.compare(source, destination, _config(source, destination))
    counts = report.counts()

    assert counts["matched"] == 1
    assert counts["missing"] == 1
    assert counts["misplaced"] == 1
    assert counts["extra"] == 1
    extra_finding = next(item for item in report.findings if item.classification == "extra")
    assert not extra_finding.actionable
    before = {path: path.read_bytes() for path in destination.rglob("*") if path.is_file()}
    assert before == {path: path.read_bytes() for path in destination.rglob("*") if path.is_file()}


def test_disconnected_input_is_unknown_coverage_and_never_missing(tmp_path: Path) -> None:
    destination = tmp_path / "destination"
    destination.mkdir()
    report = DestinationReconciliationService().compare(
        tmp_path / "offline",
        destination,
        _config(tmp_path / "offline", destination),
        input_available=False,
    )
    assert report.input_coverage == "unavailable"
    assert report.counts()["missing"] == 0
    assert "unknown, never missing" in report.issues[0]


def test_missing_destination_companion_is_confirmed_but_misplaced(tmp_path: Path) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    photo = source / "photo.jpg"
    sidecar = source / "photo.xmp"
    _photo(photo)
    sidecar.write_text("<xmp />")
    expected = destination / "2024" / "01"
    expected.mkdir(parents=True)
    shutil.copy2(photo, expected / photo.name)

    service = DestinationReconciliationService()
    config = _config(source, destination)
    report = service.compare(
        source,
        destination,
        config,
    )
    finding = next(item for item in report.findings if item.input_path == str(photo))

    assert finding.classification == "misplaced"
    assert finding.identity == "confirmed"
    assert set(finding.unit_members) == {str(photo), str(sidecar)}
    manifest = service.plan(report, (finding.finding_id,), config=config)
    assert len(manifest.actions) == 1
    assert manifest.actions[0].source.observed_path == str(sidecar)
    assert manifest.actions[0].destination_path == str(expected / sidecar.name)
    assert manifest.actions[0].companion_role == "edit_sidecar"

    for action in manifest.actions:
        execute_transfer(action)

    assert (expected / sidecar.name).read_text() == "<xmp />"


def test_actionable_finding_becomes_ordinary_copy_manifest_and_drift_blocks(
    tmp_path: Path,
) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    media = source / "missing.jpg"
    _photo(media)
    destination.mkdir()
    config = _config(source, destination)
    service = DestinationReconciliationService()
    report = service.compare(source, destination, config)
    finding = next(item for item in report.findings if item.classification == "missing")

    manifest = service.plan(report, (finding.finding_id,), config=config)

    assert manifest.actions[0].kind == "copy"
    assert manifest.actions[0].effects.source == "retained"
    media.write_bytes(media.read_bytes() + b"drift")
    try:
        service.plan(report, (finding.finding_id,), config=config)
    except ValueError as exc:
        assert "changed after reconciliation" in str(exc)
    else:
        raise AssertionError("stale reconcile plan was accepted")


def test_extra_cannot_be_converted_to_any_action(tmp_path: Path) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    source.mkdir()
    _photo(destination / "extra.jpg")
    config = _config(source, destination)
    service = DestinationReconciliationService()
    report = service.compare(source, destination, config)
    finding = next(item for item in report.findings if item.classification == "extra")
    try:
        service.plan(report, (finding.finding_id,), config=config)
    except ValueError as exc:
        assert "cannot become actions" in str(exc)
    else:
        raise AssertionError("extra content became an action")


def test_reencoded_copy_is_probable_and_requires_individual_confirmation(
    tmp_path: Path,
) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    original = source / "photo.jpg"
    reencoded = destination / "old-layout" / "photo.jpg"
    _photo(original)
    _photo(reencoded)
    # Re-encoding at another quality keeps the picture and metadata but changes
    # its content hash, which is exactly the probable-identity case.
    with Image.open(reencoded) as image:
        exif = image.getexif()
        image.save(reencoded, quality=70, exif=exif)

    config = _config(source, destination)
    service = DestinationReconciliationService()
    report = service.compare(source, destination, config)
    finding = next(item for item in report.findings if item.input_path == str(original))

    assert finding.classification == "misplaced"
    assert finding.identity == "probable"
    assert finding.requires_explicit_confirmation
    try:
        service.plan(report, (finding.finding_id,), config=config)
    except ValueError as exc:
        assert "explicit per-finding confirmation" in str(exc)
    else:
        raise AssertionError("probable match became an action without confirmation")
    manifest = service.plan(
        report,
        (finding.finding_id,),
        config=config,
        confirm_probable=(finding.finding_id,),
    )
    assert len(manifest.actions) == 1


def test_reconciling_again_after_verified_plan_is_all_matched(tmp_path: Path) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    media = source / "photo.jpg"
    _photo(media)
    destination.mkdir()
    config = _config(source, destination)
    service = DestinationReconciliationService()
    first = service.compare(source, destination, config)
    finding = next(item for item in first.findings if item.classification == "missing")
    manifest = service.plan(first, (finding.finding_id,), config=config)

    for action in manifest.actions:
        execute_transfer(action)
    second = service.compare(source, destination, config)

    assert second.counts() == {
        "missing": 0,
        "misplaced": 0,
        "extra": 0,
        "matched": 1,
        "unknown": 0,
    }
    assert media.exists()


def test_unchanged_second_reconcile_reuses_incremental_unit_facts(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    media = source / "photo.jpg"
    _photo(media)
    destination.mkdir()
    service = DestinationReconciliationService()
    config = _config(source, destination)
    real_hash = reconciliation_module.stream_sha256  # type: ignore[attr-defined]  # monkeypatching a module attribute the module imported but does not re-export
    calls = 0

    def counted(path: Path) -> tuple[str, int]:
        nonlocal calls
        calls += 1
        return real_hash(path)

    monkeypatch.setattr(reconciliation_module, "stream_sha256", counted)
    service.compare(source, destination, config)
    first_calls = calls
    service.compare(source, destination, config)

    assert first_calls > 0
    assert calls == first_calls


def test_paged_reconciliation_keeps_findings_on_disk_and_uses_stable_cursors(
    tmp_path: Path,
) -> None:
    source = tmp_path / "input"
    destination = tmp_path / "destination"
    destination.mkdir()
    for index in range(7):
        _photo(source / f"photo-{index}.jpg")
    service = DestinationReconciliationService()
    config = _config(source, destination)

    first = service.compare_paged(source, destination, config, page_size=3)
    assert len(first.findings) == 3
    assert first.counts["missing"] == 7
    assert first.next_cursor is not None
    assert service._report_path(first.report_id).is_file()  # noqa: SLF001

    second = service.page(first.report_id, cursor=first.next_cursor, page_size=3)
    third = service.page(second.report_id, cursor=second.next_cursor, page_size=3)
    finding_ids = {
        finding.finding_id for page in (first, second, third) for finding in page.findings
    }
    assert len(finding_ids) == 7
    assert third.next_cursor is None

    with pytest.raises(CursorError):
        service.page(
            first.report_id,
            cursor=first.next_cursor,
            classification="missing",
            page_size=3,
        )

    manifest = service.plan_saved(
        first.report_id,
        (first.findings[0].finding_id,),
        config=config,
    )
    assert len(manifest.actions) == 1
