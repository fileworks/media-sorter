"""P2-DEDUP-D3 / D-04 — a generation is complete only if the derived facts are.

Discovery closing its generation before hashing starts is what made this
possible: the walk saw every file, so the generation was reported `complete`
while a file it indexed had no hash at all. A file without a hash is invisible
to the duplicate workbench (grouping is a hash join), and `complete` is also
the flag that authorises marking rows missing (I-09).
"""

from __future__ import annotations

import os
import random
import threading
from collections.abc import Iterator
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import pytest
from PIL import Image
from PIL.Image import Resampling

from app.core.duplicate_plans import DuplicateGroup
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.library_validation import ValidatedLibraryProfile, validate_library_profile
from app.services import catalog_indexing, signature_extraction
from app.services.catalog import MediaCatalog
from app.services.catalog_duplicates import CatalogDuplicateIndex
from app.services.catalog_indexing import index_library_roots
from app.services.catalog_location import open_catalog
from app.services.discovery import DiscoveryStats, discover_into_catalog
from app.services.duplicate_grouping import exact_groups, similar_groups
from app.services.duplicate_service import DuplicateService
from app.services.keeper_policies import PolicySettings, apply_policy


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


def _photo(path: Path, *, colour: tuple[int, int, int] = (30, 90, 160)) -> Path:
    Image.new("RGB", (320, 240), color=colour).save(path)
    return path


def _structured_image(*, seed: int) -> Image.Image:
    """A deterministic image with low-frequency structure.

    A flat colour or a linear ramp is degenerate for a perceptual hash — the DCT
    coefficients are noise, so two encodings of the same picture land ~110 bits
    apart. Blocks give the structure a photo has; re-encoding one moves it 2.
    """
    rng = random.Random(seed)
    blocks = Image.new("RGB", (16, 16))
    blocks.putdata(
        [(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(256)]
    )
    return blocks.resize((256, 256), Resampling.NEAREST)


class TestTheWriterFillsTheReviewSurface:
    """DEC-03: `store_signature`/`store_media_facts` had zero production callers,
    so the catalog-backed burst and similar views were empty by construction."""

    def test_indexing_stores_a_phash_and_media_facts(self, tmp_path: Path) -> None:
        media = tmp_path / "media"
        media.mkdir()
        _photo(media / "a.jpg")

        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            record = next(iter(catalog.iter_files("input")))
            signature = catalog.signature_for(record, "phash")
            facts = catalog.media_facts_for(record)

        assert signature is not None
        assert signature["value"]
        assert signature["mean_rgb"]
        assert facts is not None
        assert (facts["width"], facts["height"]) == (320, 240)
        assert facts["kind"] == "image"

    def test_an_unknown_fact_is_stored_as_null_not_zero(self, tmp_path: Path) -> None:
        media = tmp_path / "media"
        media.mkdir()
        _photo(media / "a.jpg")  # no EXIF at all

        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            record = next(iter(catalog.iter_files("input")))
            facts = catalog.media_facts_for(record)

        assert facts is not None
        assert facts["camera_model"] is None
        assert facts["captured_at"] is None
        assert facts["width"] == 320

    def test_a_file_that_cannot_be_decoded_is_looked_at_once(self, tmp_path: Path) -> None:
        """Undecodable is not unreadable: unknown facts, no issue, no downgrade,
        and a facts row so the next pass does not decode it again."""
        media = tmp_path / "media"
        media.mkdir()
        (media / "not-really.jpg").write_bytes(b"\x00" * 4096)

        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            record = next(iter(catalog.iter_files("input")))
            facts = catalog.media_facts_for(record)
            assert _outcomes(catalog) == ["complete"]
            assert _issues(catalog) == []
            assert facts is not None
            assert facts["width"] is None
            assert catalog.signature_for(record, "phash") is None

    def test_reindexing_extracts_nothing_again(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media = tmp_path / "media"
        media.mkdir()
        _photo(media / "a.jpg")
        _photo(media / "b.jpg", colour=(200, 10, 10))
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        extractions: list[Path] = []

        def refuse(path: Path) -> None:
            extractions.append(path)

        monkeypatch.setattr(catalog_indexing, "extract_signature", refuse)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        assert extractions == []


class TestTheReviewSurfaceIsNoLongerEmpty:
    def test_two_encodings_of_one_photo_become_a_similar_group(self, tmp_path: Path) -> None:
        """The end of the chain `W0-UI-001` recorded as empty by construction:
        indexing now produces the signatures the perceptual view reads."""
        media = tmp_path / "media"
        media.mkdir()
        photo = _structured_image(seed=7)
        # The same picture at two JPEG qualities: perceptually equal (phash
        # distance 2 of 256 bits), never byte-equal, so it is a *similar* group
        # rather than an exact one.
        photo.save(media / "a.jpg", quality=95)
        photo.save(media / "b.jpg", quality=30)
        _structured_image(seed=99).save(media / "unrelated.jpg", quality=95)

        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            groups = list(
                similar_groups(
                    catalog,
                    CatalogDuplicateIndex(catalog),
                    max_distance=8,
                    roles=("input",),
                )
            )

        assert len(groups) == 1
        members = sorted(member.relative_path for member in groups[0].members)
        assert members == ["a.jpg", "b.jpg"]


class TestTheCostBudget:
    """P2-DEDUP-D4. Concurrency is only safe because the catalog stays on one
    thread, and only useful because it stays bounded."""

    def test_the_catalog_is_only_ever_touched_from_the_calling_thread(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        media = tmp_path / "media"
        media.mkdir()
        for index in range(12):
            _photo(media / f"{index}.jpg", colour=(index * 9, 40, 90))

        threads: set[int] = set()
        original = MediaCatalog.store_hash

        def recording(self: MediaCatalog, record: object, sha256: str) -> None:
            threads.add(threading.get_ident())
            original(self, record, sha256)  # type: ignore[arg-type]

        monkeypatch.setattr(MediaCatalog, "store_hash", recording)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        assert threads == {threading.get_ident()}

    def test_submissions_in_flight_stay_bounded(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Memory has to stay flat over a library of any size, so the pass may
        never submit the whole root and hold every result waiting to be written.

        The quantity that matters is *submitted but not yet written*, not how
        many workers run at once — the pool caps the latter no matter how far
        submission runs ahead.
        """
        media = tmp_path / "media"
        media.mkdir()
        for index in range(60):
            _photo(media / f"{index}.jpg", colour=(index * 3, 40, 90))

        counts = {"submitted": 0, "written": 0, "peak": 0}

        class CountingPool(ThreadPoolExecutor):
            def submit(self, fn, /, *args, **kwargs):  # type: ignore[no-untyped-def]
                counts["submitted"] += 1
                counts["peak"] = max(counts["peak"], counts["submitted"] - counts["written"])
                return super().submit(fn, *args, **kwargs)

        original_facts = MediaCatalog.store_media_facts

        def counting_write(self: MediaCatalog, record: object, **facts: object) -> None:
            counts["written"] += 1
            original_facts(self, record, **facts)  # type: ignore[arg-type]

        monkeypatch.setattr(catalog_indexing, "ThreadPoolExecutor", CountingPool)
        monkeypatch.setattr(MediaCatalog, "store_media_facts", counting_write)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        assert counts["submitted"] == 60
        assert counts["peak"] <= catalog_indexing.DERIVE_WORKERS * 4

    def test_progress_reports_a_known_total(self, tmp_path: Path) -> None:
        media = tmp_path / "media"
        media.mkdir()
        for index in range(5):
            _photo(media / f"{index}.jpg", colour=(index * 20, 40, 90))

        seen: list[tuple[int, int]] = []
        index_library_roots(
            _library(media),
            data_dir=tmp_path / "state",
            on_progress=lambda examined, total: seen.append((examined, total)),
        )

        assert [examined for examined, _total in seen] == [1, 2, 3, 4, 5]
        # Known, not estimated: the walk finished counting before this ran.
        assert {total for _examined, total in seen} == {5}

    def test_a_picture_beyond_the_decode_ceiling_is_not_decoded(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """Dimensions come from the header, so refusing is cheap; the file is
        still catalogued, with an unknown phash that says why."""
        photo = _photo(tmp_path / "huge.jpg")
        monkeypatch.setattr(
            signature_extraction, "image_dimensions", lambda path: (1_000_000, 1_000_000)
        )

        def refuse(*args: object, **kwargs: object) -> object:
            raise AssertionError("decoded a picture beyond the ceiling")

        monkeypatch.setattr(DuplicateService, "image_signature", refuse)
        result = signature_extraction.extract_signature(photo)

        assert result.phash.known is False
        assert result.phash.issue is not None
        assert "ceiling" in result.phash.issue
        assert result.width.value == 1_000_000


class TestKeeperPoliciesCanNowDecide:
    """P2-DEDUP-D5. `highest_resolution` refuses a group unless *every* member's
    dimensions are readable, and nothing wrote `media_facts` in production
    before D3 — so on real data it refused every group it was ever given.

    Policies act only on exact groups (DEC-01: perceptual never mutates), whose
    members are byte-identical and therefore equal on pixels. Deciding is still
    the point: the choice falls through to the tie-breakers instead of landing
    on a person's desk for a reason that was never about this group.
    """

    def _exact_group(self, tmp_path: Path) -> DuplicateGroup:
        media = tmp_path / "media"
        media.mkdir()
        photo = _structured_image(seed=21)
        photo.save(media / "a.jpg", quality=92)
        (media / "b.jpg").write_bytes((media / "a.jpg").read_bytes())

        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            groups = list(exact_groups(catalog, CatalogDuplicateIndex(catalog), roles=("input",)))
        assert len(groups) == 1
        assert len(groups[0].members) == 2
        return groups[0]

    def test_highest_resolution_decides_instead_of_refusing(self, tmp_path: Path) -> None:
        result = apply_policy(
            self._exact_group(tmp_path), PolicySettings(policy_id="highest_resolution")
        )

        assert result.decided
        assert result.reason == "highest pixel count"

    def test_best_quality_decides_without_the_degraded_wording(self, tmp_path: Path) -> None:
        result = apply_policy(self._exact_group(tmp_path), PolicySettings(policy_id="best_quality"))

        assert result.decided
        assert result.reason == "best quality (most pixels, then largest)"

    def test_without_the_writer_the_same_group_is_undecidable(self, tmp_path: Path) -> None:
        """What the two tests above actually depend on. Dropping the derived
        facts puts the group back in its pre-D3 state, and the policy refuses."""
        self._exact_group(tmp_path)
        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            for record in catalog.iter_files("input"):
                catalog.invalidate_derived(record, kinds=("media_facts",))
            stripped = list(exact_groups(catalog, CatalogDuplicateIndex(catalog), roles=("input",)))

        result = apply_policy(stripped[0], PolicySettings(policy_id="highest_resolution"))

        assert result.outcome == "needs_review"
        assert result.reason == "no member has readable dimensions"

    def test_a_policy_never_claims_pixels_it_did_not_have(self, tmp_path: Path) -> None:
        """The silent half of a silent degradation is the explanation."""
        media = tmp_path / "media"
        media.mkdir()
        (media / "a.jpg").write_bytes(b"\x00" * 2048)
        (media / "b.jpg").write_bytes(b"\x00" * 2048)
        index_library_roots(_library(media), data_dir=tmp_path / "state")

        with open_catalog(LibraryProfile().catalog, data_dir=tmp_path / "state") as catalog:
            groups = list(exact_groups(catalog, CatalogDuplicateIndex(catalog), roles=("input",)))

        result = apply_policy(groups[0], PolicySettings(policy_id="best_quality"))

        assert result.decided
        assert result.reason == "no member's dimensions could be read; decided by size"
