"""DEC-01 stage B (`P0-SAFE-002b`): a perceptual match is reviewable, and only that.

Stage A (`P0-SAFE-002a`) removed the authority — a file that merely *looked*
like another stopped being moved. That left the other half owing: a match
nobody can see is not a review, it is a silence. `P2-DEDUP-D3` landed the
signature producer, so the relationship now reaches the review surface.

What must remain true is that reaching the surface changes nothing about what
may act on it. Every automatic path that could touch a similar group is
asserted here to decline it.
"""

from __future__ import annotations

import random
from pathlib import Path
from typing import Any

import piexif
import pytest
from PIL import Image
from PIL.Image import Resampling

import app.api.routes.review as review_routes
from app.api.routes.review import DEFAULT_SIMILAR_DISTANCE
from app.core.config import Config
from app.core.duplicate_plans import DuplicateGroup
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.library_validation import ValidatedLibraryProfile, validate_library_profile
from app.services.catalog import MediaCatalog
from app.services.catalog_indexing import index_library_roots
from app.services.keeper_policies import (
    HighConfidenceRule,
    PolicySettings,
    apply_policy,
    preview_rule,
    propose_similar,
)


def _library(media: Path) -> ValidatedLibraryProfile:
    profile = LibraryProfile(roots=[LibraryRoot(root_id="input", role="input", path=str(media))])
    return validate_library_profile(profile, require_destination=False)


def _structured_image(*, seed: int) -> Image.Image:
    rng = random.Random(seed)
    blocks = Image.new("RGB", (16, 16))
    blocks.putdata(
        [(rng.randrange(256), rng.randrange(256), rng.randrange(256)) for _ in range(256)]
    )
    return blocks.resize((256, 256), Resampling.NEAREST)


@pytest.fixture
def indexed(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """One photograph stored twice at different quality: alike, not identical."""
    media = tmp_path / "media"
    media.mkdir()
    photo = _structured_image(seed=13)
    photo.save(media / "keep.jpg", quality=95)
    photo.save(media / "reencoded.jpg", quality=30)
    index_library_roots(_library(media), data_dir=tmp_path / "state")

    catalog_path = tmp_path / "state" / "catalog.db"
    if not catalog_path.exists():  # placement resolves elsewhere; find it once
        catalog_path = next((tmp_path / "state").rglob("*.db"))
    monkeypatch.setattr(review_routes, "_catalog", lambda _c: MediaCatalog(catalog_path))
    return media


@pytest.fixture
def indexed_identical_pixels(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> Path:
    """The same picture twice, differing only in metadata.

    Pixel-identical but not byte-identical, so it is a *similar* group at
    distance 0 — the only shape `_confidence` calls `high`, and therefore the
    only shape the consented rule can act on at all. Without this fixture the
    consent guard is never the deciding one and its test proves nothing.
    """
    media = tmp_path / "media"
    media.mkdir()
    photo = _structured_image(seed=13)
    photo.save(media / "one.jpg", quality=95)
    photo.save(
        media / "two.jpg",
        quality=95,
        exif=piexif.dump({"0th": {piexif.ImageIFD.Make: b"Canon"}}),
    )
    index_library_roots(_library(media), data_dir=tmp_path / "state")

    catalog_path = next((tmp_path / "state").rglob("*.db"))
    monkeypatch.setattr(review_routes, "_catalog", lambda _c: MediaCatalog(catalog_path))
    return media


def _similar_page(kind: str = "similar") -> Any:
    """The page the review surface itself asks for, at its own default distance.

    The threshold matters to more than membership: band lookup is skipped once
    `max_distance` reaches `SIGNATURE_BANDS`, and a skipped lookup stamps every
    match `unknown` confidence. Testing at an invented wider threshold would
    have measured a state the product never asks for.
    """
    return review_routes._list_groups(  # noqa: SLF001 - the review surface itself
        object(), Config(), kind, 50, DEFAULT_SIMILAR_DISTANCE, [], None
    )


class TestItReachesTheReviewSurface:
    def test_a_perceptual_match_is_offered_as_a_group(self, indexed: Path) -> None:
        page = _similar_page()

        assert len(page.groups) == 1
        members = sorted(member["relative_path"] for member in page.groups[0]["members"])
        assert members == ["keep.jpg", "reencoded.jpg"]

    def test_it_is_offered_as_similar_and_not_as_exact(self, indexed: Path) -> None:
        """The distinction is the whole point: exact byte-identity keeps its
        stronger authority, and this pair is not that."""
        assert _similar_page("similar").groups != []
        assert _similar_page("exact").groups == []


class TestItStillAuthorisesNothing:
    def test_a_keeper_policy_declines_the_group(self, indexed: Path) -> None:
        page = _similar_page()
        group = DuplicateGroup.model_validate(page.groups[0])

        for policy in ("best_quality", "highest_resolution", "largest", "newest"):
            result = apply_policy(group, PolicySettings(policy_id=policy))

            assert result.outcome == "not_applicable", policy
            assert result.decisions == ()
            assert result.keeper_member_id is None

    def test_the_high_confidence_rule_is_off_and_proposes_nothing(self, indexed: Path) -> None:
        page = _similar_page()
        group = DuplicateGroup.model_validate(page.groups[0])

        proposal = propose_similar(group, HighConfidenceRule())

        assert proposal.applies is False
        assert proposal.quarantine_member_ids == ()

    def test_even_consented_the_rule_declines_a_merely_similar_match(self, indexed: Path) -> None:
        """Stronger than expected, and worth stating: consent is not enough.

        `_confidence` calls a perceptual match `high` only at distance 0. These
        two encodings sit 2 bits apart, so even a consented rule declines them —
        the automatic path refuses at every level, not just the first.
        """
        page = _similar_page()
        group = DuplicateGroup.model_validate(page.groups[0])

        [proposal] = preview_rule(
            [group], HighConfidenceRule(max_distance=DEFAULT_SIMILAR_DISTANCE)
        )

        assert proposal.applies is False
        assert "not high confidence" in proposal.reason
        assert proposal.quarantine_member_ids == ()

    def test_the_evidence_says_how_good_the_match_is(self, indexed: Path) -> None:
        """A reviewable match has to carry its own quality, or a person is being
        asked to trust a number nobody showed them."""
        page = _similar_page()
        distances = {member["evidence"]["distance"] for member in page.groups[0]["members"]}
        confidences = {member["evidence"]["confidence"] for member in page.groups[0]["members"]}

        assert distances == {0, 2}
        # Not `unknown`: at the surface's own threshold the band lookup runs, so
        # the confidence describes the match rather than the query.
        assert confidences <= {"high", "medium", "low"}

    def test_the_files_are_all_still_there(self, indexed: Path) -> None:
        """Nothing above may have touched the library to reach its answer."""
        _similar_page()

        assert sorted(path.name for path in indexed.iterdir()) == ["keep.jpg", "reencoded.jpg"]


class TestTheOneCaseTheRuleCanAct:
    """A distance-0 perceptual match is the strongest evidence the perceptual
    path can produce, and the only kind the consented rule will touch. What it
    does there is the real test of DEC-01: propose, never mutate."""

    def test_off_by_default_it_waits_for_a_person(self, indexed_identical_pixels: Path) -> None:
        group = DuplicateGroup.model_validate(_similar_page().groups[0])

        proposal = propose_similar(group, HighConfidenceRule())

        assert proposal.applies is False
        assert "waits for review" in proposal.reason

    def test_consented_it_proposes_quarantine_and_only_quarantine(
        self, indexed_identical_pixels: Path
    ) -> None:
        group = DuplicateGroup.model_validate(_similar_page().groups[0])

        [proposal] = preview_rule(
            [group], HighConfidenceRule(max_distance=DEFAULT_SIMILAR_DISTANCE)
        )

        assert proposal.applies is True
        assert proposal.representative_member_id is not None
        assert len(proposal.quarantine_member_ids) == 1
        assert proposal.representative_member_id not in proposal.quarantine_member_ids

    def test_proposing_moves_nothing(self, indexed_identical_pixels: Path) -> None:
        group = DuplicateGroup.model_validate(_similar_page().groups[0])
        before = {path.name: path.read_bytes() for path in indexed_identical_pixels.iterdir()}

        preview_rule([group], HighConfidenceRule(max_distance=DEFAULT_SIMILAR_DISTANCE))

        after = {path.name: path.read_bytes() for path in indexed_identical_pixels.iterdir()}
        assert after == before
