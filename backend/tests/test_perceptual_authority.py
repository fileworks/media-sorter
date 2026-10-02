"""DEC-01 stage A: perceptual similarity may suggest, never place.

`D-01` gave a perceptual match the same destructive authority as byte identity:
a file that merely *looked* like another was moved out of its dated destination
into `_copies` under a "keeper" chosen by a quality heuristic. Two photographs
of the same wall are not the same file, and the product had no way to say so.

After `P0-SAFE-002a` the relationship is still detected and still reported —
`duplicate_type`, `duplicate_similarity` and `duplicate_of` are populated as
before, and `ReportPanel` already renders them — but it authorises nothing.
Exact byte-identity is untouched.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.sort_plan import PLANNED_QUARANTINE_STATUSES, build_frozen_sort_plan
from app.services.duplicate_service import DuplicateRegistry, DuplicateService

PIL_Image = pytest.importorskip("PIL.Image")
pytest.importorskip("imagehash")


def _similar_pair(tmp_path: Path) -> tuple[Path, Path]:
    """Same content, different resolutions — identical phash, different bytes."""
    source = tmp_path / "source"
    source.mkdir(exist_ok=True)
    low = source / "a_low.jpg"
    high = source / "b_high.jpg"
    PIL_Image.new("RGB", (64, 64), color=(120, 120, 120)).save(low, format="JPEG", quality=95)
    PIL_Image.new("RGB", (256, 256), color=(120, 120, 120)).save(high, format="JPEG", quality=95)
    return low, high


class TestTheStatusVocabularyIsUnchanged:
    def test_planned_quarantine_statuses_is_byte_identical_to_baseline(self) -> None:
        """`W0-TEST-001` must stay green: no status is added, reused or removed.

        The point of routing a perceptual match to "no planned placement" rather
        than to some new status is precisely that the frozen-plan vocabulary
        does not move. If this fails, the fix took the shape draft 2 proposed
        and the parity contract is broken.
        """
        assert PLANNED_QUARANTINE_STATUSES == frozenset(
            {
                "already_in_destination",
                "duplicate",
                "failed",
                "future_date",
                "junk",
                "suspicious_date",
                "unknown_date",
            }
        )


class TestTheFrozenPlan:
    def _plan(self, items: list[dict[str, object]], config: object) -> object:
        return build_frozen_sort_plan(items, config)  # type: ignore[arg-type]

    def test_a_perceptual_match_carries_no_keeper_and_no_quarantine(self, tmp_path: Path) -> None:
        from app.core.config import Config

        config = Config(
            source_directory=str(tmp_path / "source"),
            target_directory=str(tmp_path / "target"),
        )
        items: list[dict[str, object]] = [
            {
                "source": str(tmp_path / "source" / "a.jpg"),
                "destination": str(tmp_path / "target" / "2024" / "01" / "01" / "a.jpg"),
                "status": "sort",
                "file_size": 10,
                # The relationship survives as report evidence...
                "duplicate_type": "perceptual",
                "duplicate_similarity": 97,
                "duplicate_of": str(tmp_path / "source" / "b.jpg"),
            }
        ]
        (tmp_path / "source").mkdir(exist_ok=True)
        (tmp_path / "source" / "a.jpg").write_bytes(b"a")

        plan = self._plan(items, config)

        action = plan.actions[0]  # type: ignore[attr-defined]
        assert action.disposition == "sort"
        # ...but it must not become a keeper relationship on a sort action.
        assert action.keeper_path is None
        assert plan.impact.quarantine_count == 0  # type: ignore[attr-defined]

    def test_an_exact_duplicate_still_carries_its_keeper(self, tmp_path: Path) -> None:
        from app.core.config import Config

        config = Config(
            source_directory=str(tmp_path / "source"),
            target_directory=str(tmp_path / "target"),
        )
        (tmp_path / "source").mkdir(exist_ok=True)
        (tmp_path / "source" / "a.jpg").write_bytes(b"a")
        items: list[dict[str, object]] = [
            {
                "source": str(tmp_path / "source" / "a.jpg"),
                "destination": str(tmp_path / "target" / "2024" / "_copies" / "a.jpg"),
                "status": "duplicate",
                "file_size": 10,
                "duplicate_type": "exact",
                "duplicate_similarity": 100,
                "duplicate_of": str(tmp_path / "source" / "b.jpg"),
            }
        ]

        plan = self._plan(items, config)

        action = plan.actions[0]  # type: ignore[attr-defined]
        assert action.disposition == "quarantine"
        assert action.keeper_path == str(tmp_path / "source" / "b.jpg")


class TestTheExactRegistry:
    def test_a_perceptual_match_registers_its_own_path_not_the_keeper(self, tmp_path: Path) -> None:
        """C-15. The old mapping pointed this file's digest at the keeper.

        Safe only while the perceptual duplicate was quarantined out of the way.
        Under DEC-01 it stays in place, so a later byte-identical file would have
        resolved to a file whose bytes differ from its own.
        """
        low, high = _similar_pair(tmp_path)
        service = DuplicateService()
        registry = DuplicateRegistry()

        service.check_duplicate(high, registry, exact=True, perceptual=True, threshold=90)
        match = service.check_duplicate(low, registry, exact=True, perceptual=True, threshold=90)

        assert match.is_duplicate is True
        assert match.match_type == "perceptual"
        # Every digest in the registry maps to the file that actually has it.
        for digest, path in registry.exact.items():
            recorded = Path(path)
            from app.services.verified_transfer import stream_sha256

            assert stream_sha256(recorded)[0] == digest, (
                f"{recorded} is registered under a digest that is not its own"
            )

    def test_a_byte_identical_file_resolves_to_the_file_it_matches(self, tmp_path: Path) -> None:
        """Acceptance (4): identity resolves to the identical file, not a lookalike."""
        low, high = _similar_pair(tmp_path)
        twin = tmp_path / "source" / "c_twin.jpg"
        twin.write_bytes(low.read_bytes())

        service = DuplicateService()
        registry = DuplicateRegistry()
        service.check_duplicate(high, registry, exact=True, perceptual=True, threshold=90)
        service.check_duplicate(low, registry, exact=True, perceptual=True, threshold=90)
        match = service.check_duplicate(twin, registry, exact=True, perceptual=True, threshold=90)

        assert match.is_duplicate is True
        assert match.match_type == "exact"
        assert Path(str(match.original_path)).read_bytes() == twin.read_bytes()
        assert Path(str(match.original_path)) == low
