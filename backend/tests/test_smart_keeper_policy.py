"""`smart` — the default that decides when every other criterion ties.

Members of an exact group are byte-identical. Every content criterion the older
default was named for — pixels, quality — is therefore a tie by construction,
and `best_quality` fell through to an identity string, which means the copy that
survived was chosen by luck rather than by anything a user would recognise.

What genuinely differs between two identical files is *where they live* and
*what they are called*, so those are what `smart` ranks. These tests pin each
rung of the ladder, and the refusals that keep it from being clever at the
user's expense.
"""

from __future__ import annotations

import pytest

from app.core.duplicate_plans import (
    DuplicateGroup,
    FactValue,
    GroupMember,
    MemberEvidence,
    MemberFacts,
)
from app.services.keeper_policies import (
    HighConfidenceRule,
    PolicySettings,
    apply_policy,
    propose_similar,
)

SMART = PolicySettings(policy_id="smart", reference_wins=True)


def _member(
    member_id: str,
    relative_path: str,
    *,
    size: int = 1_000,
    modified: int | None = 500,
    root_id: str = "input",
    role: str = "input",
) -> GroupMember:
    return GroupMember(
        member_id=member_id,
        root_id=root_id,
        role=role,  # type: ignore[arg-type]
        relative_path=relative_path,
        observed_path=f"/{root_id}/{relative_path}",
        facts=MemberFacts(
            size_bytes=size,
            modified_at=(
                FactValue.of(modified) if modified is not None else FactValue.unknown("no mtime")
            ),
            width=FactValue.of(100),
            height=FactValue.of(100),
            media_kind="image",
        ),
        evidence=MemberEvidence(algorithm="sha256", confidence="high"),
    )


def _group(*members: GroupMember) -> DuplicateGroup:
    return DuplicateGroup(
        group_id="g",
        kind="exact",
        catalog_generation=1,
        rule_version="test",
        member_count=len(members),
        total_bytes=sum(m.facts.size_bytes for m in members),
        anchor_member_id=members[0].member_id,
        members=members,
        evidence_summary="identical bytes",
    )


def _keeper(*members: GroupMember) -> str | None:
    return apply_policy(_group(*members), SMART).keeper_member_id


class TestTheNameIsTheStrongestEvidence:
    @pytest.mark.parametrize(
        "copy_name",
        [
            "IMG_0421 copy.jpg",
            "IMG_0421 - Copy.jpg",
            "IMG_0421 (1).jpg",
            "IMG_0421-copy.jpg",
            "Copy of IMG_0421.jpg",
            "IMG_0421 Kopie.jpg",
        ],
    )
    def test_a_marked_name_loses_to_an_unmarked_one(self, copy_name: str) -> None:
        assert (
            _keeper(
                _member("copy", copy_name),
                _member("original", "IMG_0421.jpg"),
            )
            == "original"
        )

    def test_a_camera_counter_is_not_a_copy_marker(self) -> None:
        """`DSC_0002.jpg` is how a camera names files, not how a copy is named.

        Treating a bare trailing number as a copy marker would make every second
        photograph on a memory card look like a duplicate of the first.
        """
        keeper = _keeper(
            _member("second", "DSC_0002.jpg"),
            _member("first", "DSC_0001.jpg"),
        )
        # Neither is marked, so the name rung ties and the stable order decides.
        assert keeper == "first"

    def test_the_less_marked_name_wins_when_every_copy_is_marked(self) -> None:
        assert (
            _keeper(
                _member("twice", "IMG_0421 copy (2).jpg"),
                _member("once", "IMG_0421 copy.jpg"),
            )
            == "once"
        )


class TestLocationBreaksANameTie:
    def test_the_shallower_copy_wins(self) -> None:
        assert (
            _keeper(
                _member("deep", "Photos/2019/old/backup/IMG_0421.jpg"),
                _member("shallow", "Photos/2019/IMG_0421.jpg"),
            )
            == "shallow"
        )

    def test_the_name_outranks_the_location(self) -> None:
        """A pristine name deep in a tree beats a marked name at the top.

        Depth is a guess about which folder a person considers canonical; a copy
        marker is something a file manager actually wrote down.
        """
        assert (
            _keeper(
                _member("marked-shallow", "IMG_0421 copy.jpg"),
                _member("clean-deep", "a/b/c/d/IMG_0421.jpg"),
            )
            == "clean-deep"
        )


class TestTimeBreaksANameAndLocationTie:
    def test_the_oldest_copy_wins(self) -> None:
        assert (
            _keeper(
                _member("newer", "Photos/IMG_0421.jpg", modified=900),
                _member("older", "Photos/IMG_0421.jpg", modified=100),
            )
            == "older"
        )

    def test_an_unreadable_mtime_never_wins_by_looking_like_zero(self) -> None:
        """The bug this guards is treating an unknown fact as the best fact.

        Sorting `None` as 0 would make a file whose mtime could not be read the
        "oldest" copy in every group it appears in.
        """
        assert (
            _keeper(
                _member("undated", "Photos/IMG_0421.jpg", modified=None),
                _member("dated", "Photos/IMG_0421.jpg", modified=100),
            )
            == "dated"
        )


class TestItIsTotalAndRepeatable:
    def test_identical_members_still_decide(self) -> None:
        assert _keeper(_member("b", "b.jpg"), _member("a", "a.jpg")) == "a"

    def test_the_choice_does_not_depend_on_scan_order(self) -> None:
        forward = _keeper(_member("b", "b.jpg"), _member("a", "a.jpg"))
        reverse = _keeper(_member("a", "a.jpg"), _member("b", "b.jpg"))
        assert forward == reverse

    def test_a_protected_reference_still_anchors_the_group(self) -> None:
        """`smart` never overrides the copy that cannot be touched."""
        result = apply_policy(
            _group(
                _member("clean", "IMG_0421.jpg"),
                _member("ref", "IMG_0421 copy.jpg", root_id="ref", role="reference"),
            ),
            SMART,
        )
        assert result.keeper_member_id == "ref"

    def test_it_refuses_a_perceptual_group_like_every_other_policy(self) -> None:
        group = _group(_member("a", "a.jpg"), _member("b", "b.jpg"))
        similar = DuplicateGroup(**{**group.__dict__, "kind": "similar"})
        assert apply_policy(similar, SMART).outcome == "not_applicable"


class TestItExplainsItself:
    def test_the_reason_names_the_rung_that_decided(self) -> None:
        marked = apply_policy(
            _group(_member("copy", "IMG_0421 copy.jpg"), _member("original", "IMG_0421.jpg")),
            SMART,
        )
        assert "copy marker" in marked.reason

        buried = apply_policy(
            _group(_member("deep", "a/b/IMG.jpg"), _member("shallow", "IMG.jpg")),
            SMART,
        )
        assert "buried" in buried.reason

    def test_a_pure_tie_admits_that_nothing_distinguished_them(self) -> None:
        result = apply_policy(_group(_member("b", "b.jpg"), _member("a", "a.jpg")), SMART)
        assert "identical" in result.reason


class TestResolutionDecidesWhereItIsReal:
    """`P1-ARCH-002`'s other half: the criterion the names promise.

    `highest_resolution` and `best_quality` can never bite on an exact group,
    whose members are byte-identical. A *similar* group is the case those names
    actually describe — the same picture at different sizes — so that is where
    resolution chooses which copy is kept.
    """

    @staticmethod
    def _similar(*members: GroupMember) -> DuplicateGroup:
        base = _group(*members)
        return DuplicateGroup(**{**base.__dict__, "kind": "similar"})

    @staticmethod
    def _sized(member_id: str, path: str, *, width: int, height: int, size: int) -> GroupMember:
        member = _member(member_id, path, size=size)
        return GroupMember(
            **{
                **member.__dict__,
                "facts": MemberFacts(
                    size_bytes=size,
                    modified_at=FactValue.of(500),
                    width=FactValue.of(width),
                    height=FactValue.of(height),
                    media_kind="image",
                ),
                "evidence": MemberEvidence(
                    algorithm="phash", confidence="high", distance=0, threshold=0
                ),
            }
        )

    @staticmethod
    def _unmeasured(member_id: str, path: str, *, size: int) -> GroupMember:
        member = _member(member_id, path, size=size)
        return GroupMember(
            **{
                **member.__dict__,
                "facts": MemberFacts(
                    size_bytes=size,
                    modified_at=FactValue.of(500),
                    width=FactValue.unknown("unreadable"),
                    height=FactValue.unknown("unreadable"),
                    media_kind="image",
                ),
                "evidence": MemberEvidence(
                    algorithm="phash", confidence="high", distance=0, threshold=0
                ),
            }
        )

    def _rule(self) -> HighConfidenceRule:
        return HighConfidenceRule(
            enabled=True,
            max_distance=0,
            require_same_dimensions=False,
            consented_at="2026-08-20T00:00:00Z",
        )

    def test_the_higher_resolution_copy_is_the_one_kept(self) -> None:
        group = self._similar(
            self._sized("thumb", "a.jpg", width=100, height=100, size=9_000),
            self._sized("full", "b.jpg", width=400, height=400, size=1_000),
        )
        proposal = propose_similar(group, self._rule())

        assert proposal.applies
        # Note the sizes: the thumbnail is the *larger file*. Ranking on bytes
        # would have kept it and proposed quarantining the full-resolution copy.
        assert proposal.representative_member_id == "full"
        assert proposal.quarantine_member_ids == ("thumb",)

    def test_an_unmeasurable_member_sends_the_group_to_a_person(self) -> None:
        group = self._similar(
            self._sized("known", "a.jpg", width=400, height=400, size=1_000),
            self._unmeasured("unknown", "b.jpg", size=9_000),
        )
        proposal = propose_similar(group, self._rule())

        assert not proposal.applies
        assert "could not be read" in proposal.reason

    def test_requiring_equal_dimensions_still_refuses_a_mixed_group(self) -> None:
        group = self._similar(
            self._sized("thumb", "a.jpg", width=100, height=100, size=9_000),
            self._sized("full", "b.jpg", width=400, height=400, size=1_000),
        )
        strict = HighConfidenceRule(
            enabled=True,
            max_distance=0,
            require_same_dimensions=True,
            consented_at="2026-08-20T00:00:00Z",
        )
        assert not propose_similar(group, strict).applies
