"""Indexed lookup must return exactly what an exhaustive comparison would.

The band query is an optimization, and an optimization that changes the answer
is a bug. Every perceptual test here compares the indexed result against a brute
scan of the same fixture — including the pathological cases where the index is
least selective.
"""

from __future__ import annotations

import random
from pathlib import Path

import pytest

from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_duplicates import (
    CatalogDuplicateIndex,
    LookupTelemetry,
    catalog_backed_registry,
    hamming,
)
from app.services.duplicate_service import DuplicateRegistry


@pytest.fixture()
def catalog(tmp_path: Path) -> MediaCatalog:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("input", Path("/library"), role="input")
        opened.register_root("dest", Path("/destination"), role="destination")
        opened.register_root("ref", Path("/reference"), role="reference")
        yield opened


def _add(
    catalog: MediaCatalog,
    root_id: str,
    name: str,
    *,
    sha256: str | None = None,
    signature: str | None = None,
    size: int = 100,
):
    generation = catalog.begin_generation(root_id)
    [record] = catalog.observe(
        root_id,
        generation,
        [ObservedFile(name, size, 1_000, file_identity=f"{root_id}:{name}")],
    )
    # Partial on purpose: these helpers add files one at a time, and a
    # *complete* generation would correctly mark every earlier file missing.
    catalog.finish_generation(generation, "partial")
    if sha256:
        catalog.store_hash(record, sha256)
    if signature:
        catalog.store_signature(record, kind="phash", value=signature)
    return record


def _brute_force(index: CatalogDuplicateIndex, signature: str, max_distance: int, roles):
    """The answer the index must agree with, computed the slow, obvious way."""
    matches = []
    for row in index._scan_signatures("phash", roles):  # noqa: SLF001 - the reference implementation
        distance = hamming(signature, str(row["value"]))
        if distance is not None and distance <= max_distance:
            matches.append((int(row["file_id"]), distance))
    return sorted(matches)


class TestExactLookup:
    def test_a_destination_copy_is_found_by_content(self, catalog: MediaCatalog) -> None:
        _add(catalog, "dest", "kept.jpg", sha256="a" * 64)
        index = CatalogDuplicateIndex(catalog)

        assert index.has_exact_match("a" * 64)
        assert not index.has_exact_match("b" * 64)

    def test_roles_are_respected(self, catalog: MediaCatalog) -> None:
        _add(catalog, "ref", "library.jpg", sha256="c" * 64)
        index = CatalogDuplicateIndex(catalog)

        assert index.exact_matches("c" * 64, roles=("destination",)) == []
        found = index.exact_matches("c" * 64, roles=("reference",))
        assert len(found) == 1 and found[0].is_reference

    def test_a_changed_file_stops_matching_its_old_hash(self, catalog: MediaCatalog) -> None:
        record = _add(catalog, "dest", "photo.jpg", sha256="d" * 64)
        index = CatalogDuplicateIndex(catalog)
        assert index.has_exact_match("d" * 64)

        generation = catalog.begin_generation("dest")
        catalog.observe(
            "dest",
            generation,
            [ObservedFile(record.relative_path, 999, 9_999, file_identity="dest:photo.jpg")],
        )
        catalog.finish_generation(generation, "complete")

        assert not index.has_exact_match("d" * 64)

    def test_a_missing_file_is_not_offered_as_a_match(self, catalog: MediaCatalog) -> None:
        _add(catalog, "dest", "gone.jpg", sha256="e" * 64)
        index = CatalogDuplicateIndex(catalog)

        generation = catalog.begin_generation("dest")
        catalog.finish_generation(generation, "complete")  # saw nothing, completed

        assert index.exact_matches("e" * 64) == []

    def test_groups_are_yielded_one_at_a_time(self, catalog: MediaCatalog) -> None:
        for name in ("a.jpg", "b.jpg", "c.jpg"):
            _add(catalog, "input", name, sha256="1" * 64)
        _add(catalog, "input", "unique.jpg", sha256="2" * 64)
        index = CatalogDuplicateIndex(catalog)

        groups = list(index.iter_exact_groups(roles=("input",)))

        assert len(groups) == 1
        assert groups[0][0] == "1" * 64
        assert len(groups[0][1]) == 3

    def test_a_singleton_is_not_a_group(self, catalog: MediaCatalog) -> None:
        _add(catalog, "input", "only.jpg", sha256="3" * 64)
        index = CatalogDuplicateIndex(catalog)

        assert list(index.iter_exact_groups(roles=("input",))) == []

    def test_groups_span_roles_when_asked(self, catalog: MediaCatalog) -> None:
        _add(catalog, "input", "a.jpg", sha256="4" * 64)
        _add(catalog, "ref", "a.jpg", sha256="4" * 64)
        index = CatalogDuplicateIndex(catalog)

        [(_, members)] = list(index.iter_exact_groups())

        assert {member.role for member in members} == {"input", "reference"}


class TestPerceptualEquivalence:
    @pytest.mark.parametrize("max_distance", [0, 1, 2, 3])
    def test_band_lookup_matches_an_exhaustive_scan(
        self, catalog: MediaCatalog, max_distance: int
    ) -> None:
        rng = random.Random(1234)
        signatures = [f"{rng.getrandbits(64):016x}" for _ in range(120)]
        for number, signature in enumerate(signatures):
            _add(catalog, "dest", f"{number}.jpg", signature=signature)
        index = CatalogDuplicateIndex(catalog)
        probe = signatures[0]

        found = index.perceptual_candidates(probe, max_distance=max_distance, limit=1000)
        expected = _brute_force(index, probe, max_distance, ("destination", "reference"))

        assert sorted((item.record.file_id, item.distance) for item in found) == expected

    def test_a_near_duplicate_one_bit_away_is_found(self, catalog: MediaCatalog) -> None:
        base = "ffffffffffffffff"
        near = f"{int(base, 16) ^ 1:016x}"
        _add(catalog, "dest", "near.jpg", signature=near)
        index = CatalogDuplicateIndex(catalog)

        found = index.perceptual_candidates(base, max_distance=1)

        assert [item.distance for item in found] == [1]

    def test_a_distant_signature_is_not_returned(self, catalog: MediaCatalog) -> None:
        _add(catalog, "dest", "far.jpg", signature="0000000000000000")
        index = CatalogDuplicateIndex(catalog)

        assert index.perceptual_candidates("ffffffffffffffff", max_distance=3) == []

    def test_a_loose_threshold_degrades_honestly_instead_of_missing_pairs(
        self, catalog: MediaCatalog
    ) -> None:
        base = "ffffffffffffffff"
        # Six bits flipped, one in each band: no band matches exactly.
        far = f"{int(base, 16) ^ 0b1000100010001000100010001:016x}"
        _add(catalog, "dest", "far.jpg", signature=far)
        index = CatalogDuplicateIndex(catalog)
        telemetry = LookupTelemetry()

        found = index.perceptual_candidates(base, max_distance=8, telemetry=telemetry)

        assert telemetry.degraded is True
        assert [item.record.relative_path for item in found] == ["far.jpg"]

    def test_pathological_identical_bands_still_return_each_file_once(
        self, catalog: MediaCatalog
    ) -> None:
        # Every file shares three bands with the probe: the naive union would
        # return each of them three times.
        for number in range(10):
            _add(catalog, "dest", f"{number}.jpg", signature=f"aaaabbbbcccc{number:04x}")
        index = CatalogDuplicateIndex(catalog)

        found = index.perceptual_candidates("aaaabbbbcccc0000", max_distance=3, limit=100)

        assert len(found) == len({item.record.file_id for item in found})

    def test_results_are_ordered_by_distance(self, catalog: MediaCatalog) -> None:
        base = "ffffffffffffffff"
        _add(catalog, "dest", "two.jpg", signature=f"{int(base, 16) ^ 0b11:016x}")
        _add(catalog, "dest", "one.jpg", signature=f"{int(base, 16) ^ 0b1:016x}")
        index = CatalogDuplicateIndex(catalog)

        found = index.perceptual_candidates(base, max_distance=3)

        assert [item.record.relative_path for item in found] == ["one.jpg", "two.jpg"]

    def test_a_stale_signature_is_never_a_candidate(self, catalog: MediaCatalog) -> None:
        record = _add(catalog, "dest", "photo.jpg", signature="ffffffffffffffff")
        index = CatalogDuplicateIndex(catalog)

        generation = catalog.begin_generation("dest")
        catalog.observe(
            "dest",
            generation,
            [ObservedFile(record.relative_path, 42, 42, file_identity="dest:photo.jpg")],
        )
        catalog.finish_generation(generation, "complete")

        assert index.perceptual_candidates("ffffffffffffffff", max_distance=0) == []

    def test_telemetry_reports_the_work_that_was_done(self, catalog: MediaCatalog) -> None:
        for number in range(5):
            _add(catalog, "dest", f"{number}.jpg", signature=f"{number:016x}")
        index = CatalogDuplicateIndex(catalog)
        telemetry = LookupTelemetry()

        index.perceptual_candidates("0000000000000000", max_distance=1, telemetry=telemetry)

        assert telemetry.buckets_queried == 4
        assert telemetry.candidates_examined > 0
        assert telemetry.degraded is False

    def test_a_page_limit_is_respected_and_noted(self, catalog: MediaCatalog) -> None:
        for number in range(20):
            _add(catalog, "dest", f"{number}.jpg", signature="ffffffffffffffff")
        index = CatalogDuplicateIndex(catalog)
        telemetry = LookupTelemetry()

        found = index.perceptual_candidates(
            "ffffffffffffffff", max_distance=0, limit=5, telemetry=telemetry
        )

        assert len(found) == 5
        assert telemetry.notes


class TestHamming:
    def test_distance_counts_differing_bits(self) -> None:
        assert hamming("0000000000000000", "0000000000000003") == 2
        assert hamming("ffffffffffffffff", "ffffffffffffffff") == 0

    def test_incomparable_signatures_return_none(self) -> None:
        assert hamming("abc", "abcd") is None
        assert hamming("zzzz", "0000") is None


class TestCatalogBackedRegistry:
    """The registry the sort pipeline uses must behave identically either way."""

    def test_it_answers_from_the_catalog_without_loading_it(self, catalog: MediaCatalog) -> None:
        _add(catalog, "dest", "kept.jpg", sha256="a" * 64)
        registry = catalog_backed_registry(CatalogDuplicateIndex(catalog))

        assert registry.exact == {}  # nothing was materialized
        assert registry.find_exact("a" * 64) is not None
        assert registry.find_exact("b" * 64) is None

    def test_files_seen_this_run_still_win_the_lookup(self, catalog: MediaCatalog) -> None:
        _add(catalog, "dest", "kept.jpg", sha256="c" * 64)
        registry = catalog_backed_registry(CatalogDuplicateIndex(catalog))
        registry.exact["c" * 64] = "/this/run/first.jpg"

        assert registry.find_exact("c" * 64) == "/this/run/first.jpg"

    def test_a_reference_root_is_included_when_asked_for(self, catalog: MediaCatalog) -> None:
        _add(catalog, "ref", "library.jpg", sha256="d" * 64)
        index = CatalogDuplicateIndex(catalog)

        assert catalog_backed_registry(index, roles=("destination",)).find_exact("d" * 64) is None
        assert catalog_backed_registry(index, roles=("reference",)).find_exact("d" * 64) is not None

    def test_it_matches_a_materialized_registry_exactly(self, catalog: MediaCatalog) -> None:
        hashes = [f"{index:064x}" for index in range(20)]
        for number, digest in enumerate(hashes):
            _add(catalog, "dest", f"{number}.jpg", sha256=digest)
        index = CatalogDuplicateIndex(catalog)
        backed = catalog_backed_registry(index)
        materialized = DuplicateRegistry(
            exact={digest: f"dest/{number}.jpg" for number, digest in enumerate(hashes)}
        )

        for digest in [*hashes, "f" * 64]:
            assert (backed.find_exact(digest) is None) == (materialized.find_exact(digest) is None)
