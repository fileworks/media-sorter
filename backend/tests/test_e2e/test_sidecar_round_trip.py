"""Generated tag sidecars remain part of the media on subsequent imports."""

from pathlib import Path
from unittest.mock import patch

import pytest
from fastapi.testclient import TestClient

from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.destination_paths import companion_destination
from app.core.integrity import PreservationProfile
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.media_units import bind_media_units
from app.services.metadata_service import MetadataService
from tests.test_e2e.test_sorting_workflow import _create_dated_images, _wait_for_completion


@pytest.mark.parametrize("copy", [True, False])
def test_existing_generated_and_edit_sidecars_survive_a_reviewed_import(
    tmp_path: Path, copy: bool
) -> None:
    source, target = tmp_path / "source", tmp_path / "target"
    source.mkdir()
    target.mkdir()
    photo = source / "shot.JPG"
    _create_dated_images(source, [(b"2024:01:15 10:00:00", photo.name)])
    assert MetadataService().write_sidecar(photo, ["original tag"])
    (source / "shot.xmp").write_bytes(b"original editor settings")
    originals = {path.name: path.read_bytes() for path in source.iterdir()}
    config = Config(
        source_directory=str(source),
        target_directory=str(target),
        sort_criteria=["year"],
        copy_instead_of_move=copy,
        remove_duplicates=False,
        rename=True,
        rename_pattern="YYYY-MM-DD",
        ai_tagging_enabled=True,
        preservation_profile=PreservationProfile(derived_metadata="sidecar_and_report"),
    )
    app = AppFactory.create(config=config)
    with (
        patch(
            "app.services.ai.ai_tagging_service.AITaggingService.tag_file", return_value=["new tag"]
        ),
        TestClient(app) as client,
    ):
        response = client.post("/api/preview")
        assert response.status_code == 200, response.text
        plan = response.json()
        assert plan["stats"]["companions"] == 2
        assert plan["stats"]["unmatched_companions"] == 0
        expected = {
            "shot.JPG": target / "2024/2024-01-15.jpg",
            "shot.JPG.xmp": target / "2024/2024-01-15.jpg.xmp",
            "shot.xmp": target / "2024/2024-01-15.xmp",
        }
        assert {item["destination"] for item in plan["items"][0]["companions"]} == {
            str(expected["shot.JPG.xmp"]),
            str(expected["shot.xmp"]),
        }
        start = client.post(
            "/api/sorting/start", json={"dry_run": False, "plan_id": plan["plan_id"]}
        )
        assert start.status_code == 200, start.text
        task_id = start.json()["task_id"]
        assert _wait_for_completion(client, task_id)["status"] == "completed"
        response = client.get(f"/api/sorting/{task_id}/report")
        assert response.status_code == 200
        report = response.json()
        assert report["failed"] == 0 and report["incomplete_units"] == 0, report
        assert report["outcome"] == "completed", report
        saved = client.get(f"/api/reports/{report['operation_id']}")
        assert saved.status_code == 200
        records = saved.json()["files"]
        assert len(records) == 3 and all(record["status"] == "success" for record in records)
        assert next(record for record in records if record["companion_role"] is None)["tags"] == [
            "new tag"
        ]
    for name, destination in expected.items():
        assert destination.read_bytes() == originals[name]
        assert (source / name).exists() is copy
        if copy:
            assert (source / name).read_bytes() == originals[name]
    units, unmatched = bind_media_units(list(target.rglob("*.*")), target)
    assert len(units) == 1 and len(units[0].companions) == 2
    assert unmatched == []


def test_full_filename_sidecar_binds_only_to_the_named_media(tmp_path: Path) -> None:
    names = ("photo.jpg", "photo.png", "photo.jpg.xmp", "missing.jpg.xmp")
    paths = [tmp_path / name for name in names]
    for path in paths:
        path.write_bytes(b"fixture")
    units, unmatched = bind_media_units(paths, tmp_path)
    assert {
        unit.primary.name: [member.path.name for member in unit.companions] for unit in units
    } == {"photo.jpg": ["photo.jpg.xmp"], "photo.png": []}
    assert [item.path.name for item in unmatched] == ["missing.jpg.xmp"]


@pytest.mark.parametrize("case_sensitive", [True, False])
def test_raw_sibling_sidecars_keep_their_own_filename(tmp_path: Path, case_sensitive: bool) -> None:
    paths = [
        tmp_path / name for name in ("photo.CR2", "photo.JPG", "photo.CR2.xmp", "photo.JPG.xmp")
    ]
    units, unmatched = bind_media_units(paths, tmp_path, case_sensitive=case_sensitive)
    assert not unmatched and len(units) == 1
    unit = units[0]
    assert unit.primary.name == "photo.CR2"
    assert {
        companion_destination(tmp_path / "renamed_001.cr2", member.path, unit.primary).name
        for member in unit.companions
    } == {"renamed_001.JPG", "renamed_001.cr2.xmp", "renamed_001.JPG.xmp"}


def test_filename_sidecars_respect_ignore_and_filesystem_case_policy(tmp_path: Path) -> None:
    photo, sidecar = tmp_path / "photo.jpg", tmp_path / "PHOTO.JPG.xmp"
    units, unmatched = bind_media_units([photo, sidecar], tmp_path, case_sensitive=True)
    assert not units[0].companions and len(unmatched) == 1
    units, unmatched = bind_media_units([photo, sidecar], tmp_path, case_sensitive=False)
    assert len(units[0].companions) == 1 and not unmatched
    units, unmatched = bind_media_units([photo, sidecar], tmp_path, handling="ignore")
    assert not units[0].companions and not unmatched


@pytest.mark.parametrize("reference", [False, True])
def test_existing_keeper_leaves_incoming_unit_intact_without_false_failure(
    tmp_path: Path, reference: bool
) -> None:
    source, target, baseline = (tmp_path / name for name in ("source", "target", "reference"))
    for folder in (source, target, baseline):
        folder.mkdir()
    _create_dated_images(source, [(b"2024:01:15 10:00:00", "photo.jpg")])
    (source / "photo.jpg.xmp").write_bytes(b"incoming edits")
    keeper = (baseline if reference else target) / "keeper.jpg"
    keeper.write_bytes((source / "photo.jpg").read_bytes())
    originals = {path: path.read_bytes() for path in tmp_path.rglob("*") if path.is_file()}
    roots = [
        LibraryRoot(root_id="input", role="input", path=str(source)),
        LibraryRoot(root_id="target", role="destination", path=str(target)),
    ]
    if reference:
        roots.append(LibraryRoot(root_id="reference", role="reference", path=str(baseline)))
    config = Config(
        library_profile=LibraryProfile(
            profile_id="repeat-import", name="Repeat import", transfer_mode="copy", roots=roots
        ),
        remove_duplicates=True,
        duplicate_perceptual_enabled=False,
    )
    with TestClient(AppFactory.create(config=config)) as client:
        response = client.post("/api/preview")
        assert response.status_code == 200, response.text
        plan = response.json()
        start = client.post(
            "/api/sorting/start", json={"dry_run": False, "plan_id": plan["plan_id"]}
        )
        assert start.status_code == 200, start.text
        task_id = start.json()["task_id"]
        assert _wait_for_completion(client, task_id)["status"] == "completed"
        report = client.get(f"/api/sorting/{task_id}/report").json()
        assert report["failed"] == 0 and report["incomplete_units"] == 0, report
        assert report["outcome"] == "completed", report
        saved = client.get(f"/api/reports/{report['operation_id']}").json()
        primary = next(item for item in saved["files"] if item["companion_role"] is None)
        assert primary["duplicate_of"] == str(keeper)
        companion = next(item for item in saved["files"] if item["companion_role"] is not None)
        assert companion["status"] == "kept_in_place" and companion["dest_path"] is None
    assert all(path.read_bytes() == content for path, content in originals.items())
    assert {path for path in baseline.rglob("*") if path.is_file()} == {
        path for path in originals if path.is_relative_to(baseline)
    }
