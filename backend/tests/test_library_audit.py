from __future__ import annotations

from datetime import datetime
from pathlib import Path

import pytest
from PIL import Image

from app.core.config import Config
from app.services.library_audit import AuditScope, LibraryAuditService
from app.services.manifest_execution import execute_manifest


def _jpeg(path: Path, color: tuple[int, int, int] = (20, 40, 60)) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    Image.new("RGB", (24, 24), color).save(path, format="JPEG")


def test_first_audit_establishes_baseline_and_second_detects_new_divergence(
    tmp_path: Path,
) -> None:
    root = tmp_path / "library"
    file = root / "2024" / "01" / "photo.jpg"
    _jpeg(file)
    service = LibraryAuditService(tmp_path / "state" / "audit.sqlite3")
    before = file.stat()

    first = service.run(root)
    second = service.run(root)
    _jpeg(file, (200, 10, 10))
    third = service.run(root)

    assert first.coverage == "full"
    assert first.baseline_established == 1
    assert not first.findings
    assert second.baseline_established == 0
    assert not second.findings
    divergence = next(item for item in third.findings if item.category == "checksum_divergence")
    assert divergence.newly_appeared
    assert "differs from the recorded audit baseline" in divergence.evidence
    assert before.st_mode == file.stat().st_mode


def test_audit_classifies_structure_extension_and_missing_companion(tmp_path: Path) -> None:
    root = tmp_path / "library"
    photo = root / "photo.jpg"
    sidecar = root / "photo.xmp"
    _jpeg(photo)
    sidecar.write_text("<xmp />")
    invalid = root / "broken.jpg"
    invalid.write_bytes(b"not an image")
    mismatch = root / "wrong.jpg"
    Image.new("RGB", (8, 8)).save(mismatch, format="PNG")
    service = LibraryAuditService(tmp_path / "state" / "audit.sqlite3")

    first = service.run(root)
    sidecar.unlink()
    second = service.run(root)
    categories = {item.category for item in first.findings}

    assert "structurally_invalid" in categories
    assert "content_extension_mismatch" in categories
    assert any(item.category == "missing_companion" for item in second.findings)


def test_sample_scope_is_deterministic_and_never_claims_full_coverage(tmp_path: Path) -> None:
    root = tmp_path / "library"
    for index in range(40):
        _jpeg(root / f"{index:03d}.jpg", (index, index, index))
    service = LibraryAuditService(tmp_path / "state" / "audit.sqlite3")
    scope = AuditScope(sample_proportion=0.25, sample_seed="fixture")

    first = service.run(root, scope=scope)
    second = service.run(root, scope=scope)

    assert first.coverage == second.coverage == "sample"
    assert first.scanned_files == second.scanned_files
    assert 0 < first.scanned_files < 40
    assert "sha256" in first.selection_method


def test_cancellation_retains_partial_report(tmp_path: Path) -> None:
    root = tmp_path / "library"
    for index in range(6):
        _jpeg(root / f"{index}.jpg")
    service = LibraryAuditService(tmp_path / "state" / "audit.sqlite3")
    calls = 0

    def cancel() -> bool:
        nonlocal calls
        calls += 1
        return calls > 4

    report = service.run(root, cancel=cancel)

    assert report.cancelled
    assert report.coverage == "partial"
    assert service.get(report.audit_id) == report


def test_audit_fixture_matrix_classifies_unreadable_and_misplaced(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    root = tmp_path / "library"
    current_year = str(datetime.now().year)
    unreadable = root / "unreadable.jpg"
    misplaced = root / "wrong-year" / "misplaced.jpg"
    intact = root / current_year / "intact.jpg"
    _jpeg(unreadable)
    _jpeg(misplaced)
    _jpeg(intact)
    original_hash = __import__(
        "app.services.library_audit",
        fromlist=["stream_sha256"],
    ).stream_sha256

    def guarded_hash(path: Path):
        if path == unreadable:
            raise PermissionError("fixture permission refusal")
        return original_hash(path)

    monkeypatch.setattr("app.services.library_audit.stream_sha256", guarded_hash)
    config = Config(
        source_directory=str(tmp_path / "input"),
        target_directory=str(root),
        sort_criteria=["year"],
    )
    report = LibraryAuditService(tmp_path / "state" / "audit.sqlite3").run(
        root,
        config=config,
    )

    by_path = {(item.relative_path, item.category) for item in report.findings}
    assert ("unreadable.jpg", "unreadable") in by_path
    assert ("wrong-year/misplaced.jpg", "placement_inconsistency") in by_path
    assert not any(item.relative_path == f"{current_year}/intact.jpg" for item in report.findings)


def test_selected_audit_finding_uses_manifest_and_verified_transfer(
    tmp_path: Path,
) -> None:
    root = tmp_path / "library"
    current_year = str(datetime.now().year)
    misplaced = root / "old-layout" / "photo.jpg"
    _jpeg(misplaced)
    config = Config(
        source_directory=str(tmp_path / "input"),
        target_directory=str(root),
        sort_criteria=["year"],
    )
    service = LibraryAuditService(tmp_path / "state" / "audit.sqlite3")
    report = service.run(root, config=config)
    finding = next(item for item in report.findings if item.category == "placement_inconsistency")

    manifest = service.plan(report, (finding.finding_id,), config=config)
    results = execute_manifest(manifest, state_root=tmp_path / "execution-state")

    corrected = root / current_year / "photo.jpg"
    assert len(results) == 1
    assert manifest.actions[0].effects.source == "remove_after_verification"
    assert results[0].destination_path == corrected
    assert corrected.exists()
    assert not misplaced.exists()
