"""Catalog indexing uses the same canonical roots as preview and execution."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.library_validation import validate_library_profile
from app.services.catalog_indexing import index_library_roots
from app.services.catalog_location import open_catalog


def test_index_records_canonical_root_when_configured_path_is_an_alias(tmp_path: Path) -> None:
    media = tmp_path / "media"
    media.mkdir()
    (media / "photo.jpg").write_bytes(b"not-an-image-but-still-indexable")
    alias = tmp_path / "media-alias"
    try:
        alias.symlink_to(media, target_is_directory=True)
    except OSError as error:
        pytest.skip(f"directory symlinks are unavailable: {error}")

    profile = LibraryProfile(roots=[LibraryRoot(root_id="input", role="input", path=str(alias))])
    library = validate_library_profile(profile, require_destination=False)

    assert index_library_roots(library, data_dir=tmp_path / "state") == {"input": 1}
    with open_catalog(profile.catalog, data_dir=tmp_path / "state") as catalog:
        assert catalog.root_path("input") == media.resolve()
        assert [record.relative_path for record in catalog.iter_files("input")] == ["photo.jpg"]
