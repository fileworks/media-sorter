"""D-05 — an AI answer is about the file *and* what produced it.

A label cached against the file alone survives a model upgrade, a prompt
revision and a threshold change, and is then served as though it were current.
That is the wrong answer delivered confidently, which is worse than no answer:
`I-14` says a stale derived row must be a cache **miss**.
"""

from __future__ import annotations

from collections.abc import Iterator
from dataclasses import replace
from pathlib import Path

import pytest

from app.core.duplicate_plans import AiProvenance
from app.services.catalog import FileRecord, MediaCatalog, ObservedFile

BASE = AiProvenance(
    model_id="siglip2-base",
    manifest_sha256="a" * 64,
    revision="2026-08-01",
    prompt_version="7",
    threshold_version="3",
    locale="en",
)


@pytest.fixture
def catalog(tmp_path: Path) -> Iterator[MediaCatalog]:
    with MediaCatalog(tmp_path / "catalog.db") as opened:
        opened.register_root("input", tmp_path, role="input")
        yield opened


def _record(catalog: MediaCatalog) -> FileRecord:
    generation = catalog.begin_generation("input")
    [record] = catalog.observe(
        "input", generation, [ObservedFile("a.jpg", 100, 1_000, file_identity="1")]
    )
    catalog.finish_generation(generation, "complete")
    return record


class TestItRemembers:
    def test_an_answer_stored_under_one_provenance_is_returned_for_it(
        self, catalog: MediaCatalog
    ) -> None:
        record = _record(catalog)
        catalog.store_ai_fact(
            record, kind="category", label="beach", confidence=0.91, provenance=BASE
        )

        stored = catalog.ai_fact_for(record, kind="category", provenance=BASE)

        assert stored is not None
        assert stored["label"] == "beach"
        assert stored["confidence"] == pytest.approx(0.91)

    def test_restoring_the_same_answer_updates_rather_than_duplicates(
        self, catalog: MediaCatalog
    ) -> None:
        record = _record(catalog)
        for confidence in (0.4, 0.8):
            catalog.store_ai_fact(
                record, kind="category", label="beach", confidence=confidence, provenance=BASE
            )

        stored = catalog.ai_fact_for(record, kind="category", provenance=BASE)

        assert stored is not None
        assert stored["confidence"] == pytest.approx(0.8)


class TestEveryPartOfProvenanceIsPartOfTheKey:
    @pytest.mark.parametrize(
        "field",
        [
            "model_id",
            "manifest_sha256",
            "revision",
            "prompt_version",
            "threshold_version",
            "locale",
        ],
    )
    def test_a_change_is_a_miss_not_a_stale_answer(self, catalog: MediaCatalog, field: str) -> None:
        record = _record(catalog)
        catalog.store_ai_fact(
            record, kind="category", label="beach", confidence=0.91, provenance=BASE
        )
        changed = BASE.model_copy(update={field: "something-else"})

        assert catalog.ai_fact_for(record, kind="category", provenance=changed) is None

    def test_a_different_kind_is_a_different_answer(self, catalog: MediaCatalog) -> None:
        record = _record(catalog)
        catalog.store_ai_fact(
            record, kind="category", label="beach", confidence=0.91, provenance=BASE
        )

        assert catalog.ai_fact_for(record, kind="caption", provenance=BASE) is None

    def test_changed_bytes_are_a_miss(self, catalog: MediaCatalog) -> None:
        """The file half of the key: the same model on different pixels is a
        different answer too."""
        record = _record(catalog)
        catalog.store_ai_fact(
            record, kind="category", label="beach", confidence=0.91, provenance=BASE
        )
        moved = replace(record, fingerprint="v2:cache_hint:999:1:-:1:-")

        assert catalog.ai_fact_for(moved, kind="category", provenance=BASE) is None

    def test_both_provenances_can_coexist(self, catalog: MediaCatalog) -> None:
        """An upgrade must not destroy the old answer — it must stop *serving*
        it. Keeping both is what lets a downgrade still find its own."""
        record = _record(catalog)
        newer = BASE.model_copy(update={"model_id": "siglip2-large"})
        catalog.store_ai_fact(
            record, kind="category", label="beach", confidence=0.91, provenance=BASE
        )
        catalog.store_ai_fact(
            record, kind="category", label="coast", confidence=0.77, provenance=newer
        )

        old = catalog.ai_fact_for(record, kind="category", provenance=BASE)
        new = catalog.ai_fact_for(record, kind="category", provenance=newer)

        assert old is not None and old["label"] == "beach"
        assert new is not None and new["label"] == "coast"


class TestTheSchemaCarriesIt:
    def test_a_fresh_catalog_has_the_table(self, catalog: MediaCatalog) -> None:
        names = {
            str(row["name"])
            for row in catalog._connection.execute(  # noqa: SLF001 - schema assertion
                "SELECT name FROM sqlite_master WHERE type = 'table'"
            )
        }

        assert "ai_facts" in names

    def test_a_migrated_catalog_gains_it(self, tmp_path: Path) -> None:
        """A v3 catalog predates the table, and `CREATE TABLE IF NOT EXISTS`
        gives it one — the case D1 recorded as untested for the other tables."""
        path = tmp_path / "old.db"
        with MediaCatalog(path) as first:
            first.register_root("input", tmp_path, role="input")
            first._connection.execute("PRAGMA user_version = 3")  # noqa: SLF001 - migration fixture
            first._connection.execute("DROP TABLE ai_facts")  # noqa: SLF001

        with MediaCatalog(path) as migrated:
            names = {
                str(row["name"])
                for row in migrated._connection.execute(  # noqa: SLF001 - schema assertion
                    "SELECT name FROM sqlite_master WHERE type = 'table'"
                )
            }

        assert "ai_facts" in names
