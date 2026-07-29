"""Groups come from the catalog, carry their evidence, and admit what is unknown."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.catalog import MediaCatalog, ObservedFile
from app.services.catalog_duplicates import CatalogDuplicateIndex
from app.services.duplicate_grouping import exact_groups, similar_groups


@pytest.fixture()
def catalog(tmp_path: Path) -> MediaCatalog:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("input", tmp_path / "input", role="input")
        opened.register_root("dest", tmp_path / "dest", role="destination")
        opened.register_root("ref", tmp_path / "library", role="reference")
        yield opened


def add(
    catalog: MediaCatalog,
    root_id: str,
    name: str,
    *,
    sha256: str | None = None,
    signature: str | None = None,
    size: int = 100,
    facts: dict | None = None,
):
    generation = catalog.begin_generation(root_id)
    [record] = catalog.observe(
        root_id,
        generation,
        [ObservedFile(name, size, 1_000, file_identity=f"{root_id}:{name}")],
    )
    catalog.finish_generation(generation, "partial")
    if sha256:
        catalog.store_hash(record, sha256)
    if signature:
        catalog.store_signature(record, kind="phash", value=signature)
    if facts:
        catalog.store_media_facts(record, **facts)
    return record


class TestExactGroups:
    def test_identical_content_across_roots_forms_one_group(self, catalog: MediaCatalog) -> None:
        add(catalog, "input", "a.jpg", sha256="a" * 64)
        add(catalog, "dest", "a.jpg", sha256="a" * 64)
        add(catalog, "ref", "a.jpg", sha256="a" * 64)

        groups = list(exact_groups(catalog, CatalogDuplicateIndex(catalog)))

        assert len(groups) == 1
        assert {member.role for member in groups[0].members} == {
            "input",
            "destination",
            "reference",
        }

    def test_every_member_carries_high_confidence_hash_evidence(
        self, catalog: MediaCatalog
    ) -> None:
        add(catalog, "input", "a.jpg", sha256="b" * 64)
        add(catalog, "input", "b.jpg", sha256="b" * 64)

        [group] = list(exact_groups(catalog, CatalogDuplicateIndex(catalog)))

        assert all(member.evidence.confidence == "high" for member in group.members)
        assert all(member.evidence.sha256 == "b" * 64 for member in group.members)
        assert "identical content" in group.evidence_summary

    def test_reference_members_are_protected(self, catalog: MediaCatalog) -> None:
        add(catalog, "input", "a.jpg", sha256="c" * 64)
        add(catalog, "ref", "a.jpg", sha256="c" * 64)

        [group] = list(exact_groups(catalog, CatalogDuplicateIndex(catalog)))

        assert group.has_protected_member is True
        assert len(group.mutable_members) == 1

    def test_group_ids_are_stable_across_runs(self, catalog: MediaCatalog) -> None:
        add(catalog, "input", "a.jpg", sha256="d" * 64)
        add(catalog, "input", "b.jpg", sha256="d" * 64)
        index = CatalogDuplicateIndex(catalog)

        first = [group.group_id for group in exact_groups(catalog, index)]
        second = [group.group_id for group in exact_groups(catalog, index)]

        assert first == second

    def test_a_limit_stops_producing_early(self, catalog: MediaCatalog) -> None:
        for digest in ("e", "f"):
            add(catalog, "input", f"{digest}1.jpg", sha256=digest * 64)
            add(catalog, "input", f"{digest}2.jpg", sha256=digest * 64)

        assert len(list(exact_groups(catalog, CatalogDuplicateIndex(catalog), limit=1))) == 1

    def test_unextracted_facts_are_marked_unknown_not_zero(self, catalog: MediaCatalog) -> None:
        add(catalog, "input", "a.jpg", sha256="1" * 64)
        add(catalog, "input", "b.jpg", sha256="1" * 64)

        [group] = list(exact_groups(catalog, CatalogDuplicateIndex(catalog)))

        member = group.members[0]
        assert member.facts.width.known is False
        assert member.facts.width.issue is not None
        assert member.facts.pixels is None

    def test_stored_facts_are_carried_into_the_group(self, catalog: MediaCatalog) -> None:
        add(
            catalog,
            "input",
            "a.jpg",
            sha256="2" * 64,
            facts={"kind": "image", "width": 4000, "height": 3000},
        )
        add(catalog, "input", "b.jpg", sha256="2" * 64)

        [group] = list(exact_groups(catalog, CatalogDuplicateIndex(catalog)))

        measured = next(m for m in group.members if m.relative_path == "a.jpg")
        assert measured.facts.pixels == 12_000_000
        assert measured.facts.media_kind == "image"


class TestSimilarGroups:
    def test_near_matches_form_a_group_with_distance_evidence(self, catalog: MediaCatalog) -> None:
        base = "ffffffffffffffff"
        add(catalog, "input", "a.jpg", signature=base)
        add(catalog, "input", "b.jpg", signature=f"{int(base, 16) ^ 0b11:016x}")

        groups = list(
            similar_groups(
                catalog, CatalogDuplicateIndex(catalog), max_distance=3, roles=("input",)
            )
        )

        assert len(groups) == 1
        distances = {member.evidence.distance for member in groups[0].members}
        assert distances == {0, 2}

    def test_a_lone_file_is_not_a_group(self, catalog: MediaCatalog) -> None:
        add(catalog, "input", "a.jpg", signature="ffffffffffffffff")

        assert (
            list(
                similar_groups(
                    catalog, CatalogDuplicateIndex(catalog), max_distance=3, roles=("input",)
                )
            )
            == []
        )

    def test_a_file_is_only_used_as_a_seed_once(self, catalog: MediaCatalog) -> None:
        base = int("ffffffffffffffff", 16)
        for index in range(4):
            add(catalog, "input", f"{index}.jpg", signature=f"{base ^ index:016x}")

        groups = list(
            similar_groups(
                catalog, CatalogDuplicateIndex(catalog), max_distance=3, roles=("input",)
            )
        )

        assert len(groups) == 1
        assert groups[0].member_count == 4

    def test_byte_identical_members_belong_to_the_exact_group_instead(
        self, catalog: MediaCatalog
    ) -> None:
        signature = "ffffffffffffffff"
        add(catalog, "input", "a.jpg", sha256="3" * 64, signature=signature)
        add(catalog, "input", "b.jpg", sha256="3" * 64, signature=signature)

        groups = list(
            similar_groups(
                catalog, CatalogDuplicateIndex(catalog), max_distance=0, roles=("input",)
            )
        )

        assert groups == []

    def test_confidence_falls_off_with_distance(self, catalog: MediaCatalog) -> None:
        base = int("ffffffffffffffff", 16)
        add(catalog, "input", "a.jpg", signature=f"{base:016x}")
        add(catalog, "input", "b.jpg", signature=f"{base ^ 0b111:016x}")

        [group] = list(
            similar_groups(
                catalog, CatalogDuplicateIndex(catalog), max_distance=3, roles=("input",)
            )
        )

        by_distance = {
            member.evidence.distance: member.evidence.confidence for member in group.members
        }
        assert by_distance[0] == "high"
        assert by_distance[3] == "low"

    def test_the_anchor_is_a_member_of_its_own_group(self, catalog: MediaCatalog) -> None:
        base = int("ffffffffffffffff", 16)
        add(catalog, "input", "a.jpg", signature=f"{base:016x}")
        add(catalog, "input", "b.jpg", signature=f"{base ^ 1:016x}")

        [group] = list(
            similar_groups(
                catalog, CatalogDuplicateIndex(catalog), max_distance=2, roles=("input",)
            )
        )

        assert group.anchor_member_id is not None
        assert any(member.member_id == group.anchor_member_id for member in group.members)
