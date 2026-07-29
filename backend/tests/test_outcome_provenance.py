from __future__ import annotations

import json
from datetime import date
from pathlib import Path
from types import SimpleNamespace

from app.core.config import Config
from app.core.integrity import PreservationProfile
from app.services.ai.category_classifier_service import CategoryResult
from app.services.extraction_service import DateCandidate, DateExtractionService, ExtractionResult
from app.services.mutation_planner import build_placement_action
from app.services.outcome_provenance import build_outcome_provenance
from app.services.verified_transfer import execute_transfer


def test_bounded_provenance_records_decisions_and_is_carried_by_action(tmp_path: Path) -> None:
    source_root = tmp_path / "input"
    destination_root = tmp_path / "output"
    source = source_root / "camera" / "IMG_1.jpg"
    source.parent.mkdir(parents=True)
    source.write_bytes(b"media")
    destination = destination_root / "2024" / "03" / "travel" / "trip" / "2024_IMG_1.png"
    config = Config(
        source_directory=str(source_root),
        target_directory=str(destination_root),
        sort_criteria=["year", "month"],
        categorize_enabled=True,
        categorize_confidence_threshold=0.55,
        convert_images=True,
        image_format="png",
        rename=True,
        rename_pattern="YYYY_NAME",
    )
    extraction = ExtractionResult(
        date(2024, 3, 2),
        "filename",
        candidates=(
            DateCandidate("exif", None, False, "absent"),
            DateCandidate("filename", date(2024, 3, 2), True, "selected"),
        ),
    )
    tag_match = SimpleNamespace(name="Camera JPEG", priority=2, saved_order=1)
    route_match = SimpleNamespace(name="Trips", priority=4, saved_order=0)
    rules = SimpleNamespace(
        matched_tag_rules=(tag_match,),
        matched_route_rule=route_match,
    )

    provenance = build_outcome_provenance(
        file_path=source,
        source_root=source_root,
        destination=destination,
        config=config,
        extraction=extraction,
        rules=rules,
        category=CategoryResult("travel", 0.81, 0.32),
        duplicate_evaluated=True,
        duplicate_type="perceptual",
        duplicate_similarity=97,
        duplicate_of="/reference/IMG_1.jpg",
        route_suffix="trip",
        unit_id="unit-1",
        unit_members=(str(source),),
    )
    action = build_placement_action(
        source,
        destination,
        kind="copy",
        move=False,
        preservation=PreservationProfile(),
        root_id="input",
        relative_path="camera/IMG_1.jpg",
        provenance=provenance,
    )

    assert action.provenance is provenance
    assert provenance.date.candidates[0].rejection_reason == "absent"
    assert provenance.categorization.confidence == 0.81
    assert provenance.duplicate.perceptual_distance == 3
    assert provenance.rules.winning_route is not None
    assert provenance.rules.winning_route.name == "Trips"
    assert [part.decision for part in provenance.path] == [
        "date",
        "date",
        "category",
        "route",
        "conversion",
        "rename",
    ]
    assert len(json.dumps(provenance.model_dump(mode="json"))) < 4_096

    result = execute_transfer(action)
    assert result.destination_path == destination
    assert result.destination_path.read_bytes() == source.read_bytes()
    executed_action = action.model_dump(mode="json")
    assert executed_action["destination_path"] == str(result.destination_path)
    assert executed_action["provenance"] == provenance.model_dump(mode="json")


def test_rejected_date_candidates_are_capped() -> None:
    config = Config(source_directory="/input", target_directory="/output")
    extraction = ExtractionResult(
        None,
        "none",
        candidates=tuple(DateCandidate(f"source-{n}", None, False, "absent") for n in range(20)),
    )
    provenance = build_outcome_provenance(
        file_path=Path("/input/a.jpg"),
        source_root=Path("/input"),
        destination=None,
        config=config,
        extraction=extraction,
        rules=None,
        category=CategoryResult(None, 0.0, 0.0),
        duplicate_evaluated=False,
    )
    assert len(provenance.date.candidates) == 8


def test_absent_sentinel_and_filename_winner_have_distinct_explanations(
    tmp_path: Path,
    monkeypatch,
) -> None:
    service = DateExtractionService()
    filesystem_only = tmp_path / "plain.jpg"
    sentinel = tmp_path / "2024-03-02-sentinel.jpg"
    filename = tmp_path / "2024-03-02-filename.jpg"
    for path in (filesystem_only, sentinel, filename):
        path.write_bytes(b"fixture")

    monkeypatch.setattr(service, "_from_exif", lambda _path: (None, "none"))
    absent = service.extract_detailed(filesystem_only)
    filename_result = service.extract_detailed(filename)
    monkeypatch.setattr(service, "_from_exif", lambda _path: (date(2000, 1, 1), "exif"))
    sentinel_result = service.extract_detailed(sentinel)

    assert [(item.source, item.reason) for item in absent.candidates[:2]] == [
        ("exif", "absent"),
        ("filename", "absent"),
    ]
    assert filename_result.source == "filename"
    assert filename_result.candidates[-1].reason == "selected"
    assert sentinel_result.suspicious
    assert sentinel_result.candidates[0].reason == "suspicious"
    assert sentinel_result.source == "filename"


def test_below_threshold_category_records_failed_threshold() -> None:
    config = Config(
        source_directory="/input",
        target_directory="/output",
        categorize_enabled=True,
        categorize_confidence_threshold=0.55,
    )
    provenance = build_outcome_provenance(
        file_path=Path("/input/photo.jpg"),
        source_root=Path("/input"),
        destination=Path("/output/2024/_uncategorized/photo.jpg"),
        config=config,
        extraction=ExtractionResult(
            date(2024, 1, 1),
            "filename",
            candidates=(DateCandidate("filename", date(2024, 1, 1), True, "selected"),),
        ),
        rules=None,
        category=CategoryResult(None, 0.42, 0.05),
        duplicate_evaluated=False,
    )
    assert provenance.categorization.label is None
    assert provenance.categorization.confidence == 0.42
    assert provenance.categorization.threshold == 0.55
    assert provenance.categorization.passed is False
    category_segment = next(item for item in provenance.path if item.decision == "category")
    assert category_segment.segment == "_uncategorized"
