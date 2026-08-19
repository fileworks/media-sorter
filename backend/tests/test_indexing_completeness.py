"""P2-DEDUP-D3 / D-04 — a generation is complete only if the derived facts are.

Discovery closing its generation before hashing starts is what made this
possible: the walk saw every file, so the generation was reported `complete`
while a file it indexed had no hash at all. A file without a hash is invisible
to the duplicate workbench (grouping is a hash join), and `complete` is also
the flag that authorises marking rows missing (I-09).
"""

from __future__ import annotations

import os
from collections.abc import Iterator
from pathlib import Path

import pytest

from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.library_validation import ValidatedLibraryProfile, validate_library_profile
from app.services import catalog_indexing
from app.services.catalog import MediaCatalog
from app.services.catalog_indexing import index_library_roots
from app.services.catalog_location import open_catalog
from app.services.discovery import DiscoveryStats, discover_into_catalog


def _library(media: Path) -> ValidatedLibraryProfile:
    profile = LibraryProfile(roots=[LibraryRoot(root_id="input", role="input", path=str(media))])
    return validate_library_profile(profile, require_destination=False)


def _catalog(tmp_path: Path) -> Iterator[MediaCatalog]:
    with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
        yield catalog


def _outcomes(catalog: MediaCatalog) -> list[str]:
    rows = catalog._connection.execute(  # noqa: SLF001 - no public reader for a non-complete outcome
        "SELECT outcome FROM scan_generations ORDER BY generation_id"
    ).fetchall()
    return [str(row["outcome"]) for row in rows]


def _issues(catalog: MediaCatalog) -> list[tuple[str, str]]:
    rows = catalog._connection.execute(  # noqa: SLF001 - issues have no public reader yet
        "SELECT path, error_class FROM issues ORDER BY issue_id"
    ).fetchall()
    return [(str(row["path"]), str(row["error_class"])) for row in rows]


@pytest.fixture
def unreadable(tmp_path: Path) -> Iterator[Path]:
    """A file the walk can see and the hash pass cannot read."""
    media = tmp_path / "media"
    media.mkdir()
    (media / "readable.jpg").write_bytes(b"a" * 64)
    locked = media / "locked.jpg"
    locked.write_bytes(b"b" * 64)
    os.chmod(locked, 0o000)
    try:
        if os.access(locked, os.R_OK):  # running as root, or a filesystem without modes
            pytest.fail("the fixture cannot make a file unreadable on this host")
        yield media
    finally:
        os.chmod(locked, 0o600)


class TestAnUnhashableFileDowngradesTheGeneration:
    def test_the_generation_is_partial_not_complete(self, tmp_path: Path, unreadable: Path) -> None:
        index_library_roots(_library(unreadable), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            assert _outcomes(catalog) == ["partial"]
            assert catalog.last_complete_generation("input") is None

    def test_the_file_that_could_not_be_hashed_is_recorded(
        self, tmp_path: Path, unreadable: Path
    ) -> None:
        index_library_roots(_library(unreadable), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            recorded = _issues(catalog)

        assert [path for path, _class in recorded if path.endswith("locked.jpg")]
        assert {error_class for _path, error_class in recorded} == {"hash_unreadable"}

    def test_the_readable_file_is_still_hashed(self, tmp_path: Path, unreadable: Path) -> None:
        """One bad file must not cost the hashes of the good ones."""
        index_library_roots(_library(unreadable), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            hashes = {r.relative_path: catalog.hash_for(r) for r in catalog.iter_files("input")}

        assert hashes["readable.jpg"] is not None
        assert hashes["locked.jpg"] is None


class TestACompleteLibraryStaysComplete:
    """The control. Without it, a downgrade that fires on everything passes."""

    def test_every_file_hashed_yields_complete(self, tmp_path: Path) -> None:
        media = tmp_path / "media"
        media.mkdir()
        (media / "a.jpg").write_bytes(b"a" * 64)
        (media / "b.jpg").write_bytes(b"b" * 64)

        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            assert _outcomes(catalog) == ["complete"]
            assert catalog.last_complete_generation("input") is not None
            assert _issues(catalog) == []
            assert catalog.diagnostics().hashed_files == 2


class TestIndexingIsACacheHit:
    def test_reindexing_an_unchanged_library_rereads_nothing(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media = tmp_path / "media"
        media.mkdir()
        (media / "a.jpg").write_bytes(b"a" * 64)
        (media / "b.jpg").write_bytes(b"b" * 64)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        reads: list[Path] = []
        original = catalog_indexing._sha256_of  # noqa: SLF001 - counting real work

        def counting(path: Path, **kwargs: object) -> str:
            reads.append(path)
            return original(path)

        monkeypatch.setattr(catalog_indexing, "_sha256_of", counting)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        assert reads == []

    def test_a_changed_file_is_reread(self, tmp_path: Path) -> None:
        media = tmp_path / "media"
        media.mkdir()
        target = media / "a.jpg"
        target.write_bytes(b"a" * 64)
        index_library_roots(_library(media), data_dir=tmp_path / "state")
        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            before = next(catalog.hash_for(r) for r in catalog.iter_files("input"))

        target.write_bytes(b"c" * 128)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            after = next(catalog.hash_for(r) for r in catalog.iter_files("input"))
        assert after is not None
        assert after != before


class TestI09:
    """Only a complete generation may mark rows missing."""

    def test_a_partial_generation_leaves_a_vanished_row_alone(self, tmp_path: Path) -> None:
        media = tmp_path / "media"
        media.mkdir()
        (media / "keeper.jpg").write_bytes(b"a" * 64)
        (media / "vanishes.jpg").write_bytes(b"b" * 64)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        # The second pass sees one fewer file *and* cannot hash what remains.
        (media / "vanishes.jpg").unlink()
        os.chmod(media / "keeper.jpg", 0o000)
        try:
            index_library_roots(_library(media), data_dir=tmp_path / "state")
        finally:
            os.chmod(media / "keeper.jpg", 0o600)

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            assert _outcomes(catalog) == ["complete", "partial"]
            # The row is still there, unmarked: a scan that could not finish its
            # work has not earned the right to call anything missing.
            assert catalog.diagnostics().missing_files == 0
            assert sorted(r.relative_path for r in catalog.iter_files("input")) == [
                "keeper.jpg",
                "vanishes.jpg",
            ]

    def test_a_complete_generation_still_marks_a_vanished_row(self, tmp_path: Path) -> None:
        """The other half of the contract — the downgrade must not disable pruning."""
        media = tmp_path / "media"
        media.mkdir()
        (media / "keeper.jpg").write_bytes(b"a" * 64)
        (media / "vanishes.jpg").write_bytes(b"b" * 64)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        (media / "vanishes.jpg").unlink()
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            assert _outcomes(catalog) == ["complete", "complete"]
            assert catalog.diagnostics().missing_files == 1


class TestCancellation:
    def test_cancelling_during_hashing_never_reports_complete(self, tmp_path: Path) -> None:
        media = tmp_path / "media"
        media.mkdir()
        for index in range(4):
            (media / f"{index}.jpg").write_bytes(bytes([index]) * 64)

        calls = {"n": 0}

        def cancel() -> bool:
            # Let discovery finish, then stop the hash pass part-way.
            calls["n"] += 1
            return calls["n"] > 6

        index_library_roots(_library(media), data_dir=tmp_path / "state", cancel=cancel)

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            assert "complete" not in _outcomes(catalog)
            assert catalog.last_complete_generation("input") is None
            assert catalog.diagnostics().missing_files == 0


class TestAnAbortedScanIsNeverComplete:
    def test_a_raising_derive_pass_leaves_the_generation_not_complete(self, tmp_path: Path) -> None:
        """The `finally` closes every generation. It must not close this one as
        `complete` merely because nothing had been recorded as an issue yet."""
        media = tmp_path / "media"
        media.mkdir()
        (media / "a.jpg").write_bytes(b"a" * 64)

        def boom(root_id: str, stats: DiscoveryStats) -> None:
            raise RuntimeError("derivation blew up")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            catalog.register_root("input", media, role="input")
            with pytest.raises(RuntimeError, match="blew up"):
                discover_into_catalog(catalog, "input", media, derive=boom)

            assert _outcomes(catalog) == ["partial"]
            assert catalog.last_complete_generation("input") is None
            assert catalog.diagnostics().missing_files == 0
