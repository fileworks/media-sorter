"""A Sources-stage exclusion scopes every operation that enumerates media."""

from __future__ import annotations

import uuid
from pathlib import Path
from unittest.mock import patch

from fastapi.testclient import TestClient
from PIL import Image

from app.core.bootstrap import AppFactory
from app.core.config import Config
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.paths import resolve_app_paths
from app.services.catalog_location import open_catalog


def _library(tmp_path: Path, *, identical: bool = False) -> tuple[Config, Path, Path, str, str]:
    phone = tmp_path / "phone"
    camera = tmp_path / "camera"
    destination = tmp_path / "destination"
    for path in (phone, camera, destination):
        path.mkdir()
    first = Image.new("RGB", (16, 16), "navy")
    first.save(phone / "2024-01-02-phone.jpg")
    (first if identical else Image.new("RGB", (16, 16), "olive")).save(
        camera / "2024-01-03-camera.jpg"
    )
    suffix = uuid.uuid4().hex
    phone_id = f"phone-{suffix}"
    camera_id = f"camera-{suffix}"
    profile = LibraryProfile(
        profile_id=f"scope-{suffix}",
        name="Run scope API test",
        transfer_mode="copy",
        roots=[
            LibraryRoot(root_id=phone_id, role="input", path=str(phone)),
            LibraryRoot(root_id=camera_id, role="input", path=str(camera)),
            LibraryRoot(root_id=f"destination-{suffix}", role="destination", path=str(destination)),
        ],
    )
    config = Config(
        source_directory=str(phone),
        target_directory=str(destination),
        copy_instead_of_move=True,
        remove_duplicates=True,
        library_profile=profile,
    )
    return config, phone, camera, phone_id, camera_id


def test_skipped_root_never_reaches_scan_analysis_preview_or_catalog(tmp_path: Path) -> None:
    config, phone, camera, phone_id, camera_id = _library(tmp_path)
    (camera / "2024-01-03-camera.xmp").write_bytes(b"sidecar")
    real_iterdir = Path.iterdir

    def guarded_iterdir(path: Path):  # type: ignore[no-untyped-def]
        if path == camera:
            raise AssertionError("skipped root was enumerated")
        return real_iterdir(path)

    app = AppFactory.create(config=config)
    with patch.object(Path, "iterdir", guarded_iterdir), TestClient(app) as client:
        scan = client.post("/api/scan", json={"excluded_roots": [camera_id]})
        analysis = client.post("/api/analysis", json={"excluded_roots": [camera_id]})
        preview = client.post("/api/preview", json={"excluded_roots": [camera_id]})

    assert scan.status_code == 200
    assert scan.json()["files"] == [str(phone / "2024-01-02-phone.jpg")]
    assert scan.json()["excluded_root_ids"] == [camera_id]
    assert scan.json()["companion_files"] == 0
    assert analysis.status_code == 200
    assert analysis.json()["total_files"] == 1
    assert analysis.json()["excluded_roots"] == [str(camera)]
    assert preview.status_code == 200
    assert preview.json()["stats"]["total"] == 1
    assert preview.json()["stats"]["companions"] == 0
    assert preview.json()["stats"]["companion_split_warnings"] == 0
    assert {item["source"] for item in preview.json()["items"]} == {
        str(phone / "2024-01-02-phone.jpg")
    }

    assert config.library_profile is not None
    with open_catalog(
        config.library_profile.catalog, data_dir=resolve_app_paths().data_dir
    ) as catalog:
        assert catalog.count_files(phone_id) == 1
        assert catalog.root_path(camera_id) is None


def test_duplicate_catalog_omits_a_set_that_spans_the_skipped_root(tmp_path: Path) -> None:
    config, phone, camera, _phone_id, camera_id = _library(tmp_path, identical=True)
    app = AppFactory.create(config=config)
    with TestClient(app) as client:
        preview = client.post("/api/preview")
        assert preview.status_code == 200
        all_groups = client.get("/api/review/groups", params={"kind": "exact", "limit": 500})
        scoped_groups = client.get(
            "/api/review/groups",
            params={"kind": "exact", "limit": 500, "excluded_roots": camera_id},
        )

    expected_paths = {
        (phone / "2024-01-02-phone.jpg").resolve(),
        (camera / "2024-01-03-camera.jpg").resolve(),
    }

    def contains_pair(response: dict[str, object]) -> bool:
        groups = response["groups"]
        assert isinstance(groups, list)
        return any(
            expected_paths.issubset(
                {Path(member["observed_path"]).resolve() for member in group["members"]}
            )
            for group in groups
        )

    assert contains_pair(all_groups.json()) is True
    assert contains_pair(scoped_groups.json()) is False
