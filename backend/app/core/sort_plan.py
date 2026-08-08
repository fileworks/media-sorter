"""Frozen preview plan consumed by the sort executor.

The preview is the point at which a user reviews destinations and consequences.
This contract keeps those decisions immutable and gives the transfer boundary a
small, exact authorization record to check before it writes anything.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.exceptions import ConflictError, PlanAuthorizationError
from app.core.integrity import MutationActionKind, SourceEffect
from app.core.provenance import OutcomeProvenance
from app.services.destination import (
    CONTEXTUAL_COPY_FOLDER,
    QUARANTINE_FOLDERS,
    companion_destination,
    copy_destination,
    reserve_destination,
)
from app.services.outcome_provenance import contextualize_copy

PlannedDisposition = Literal[
    "sort",
    "quarantine",
]

#: Preview statuses that carry a review-folder destination.
#:
#: This is the one list, read rather than restated wherever the question "does
#: this file go to a review folder?" is asked — `preview_service` derives its
#: own set from it, and `reviewStatuses.test.ts` pins the frontend to it.
#: Restating it was how `suspicious_date` came to be previewed into the undated
#: folder while the plan authorized nothing: the run then reached the
#: whitelist with an unplanned placement, recorded the file as *failed*, and
#: told the user to generate the preview again — which produced the same plan
#: and the same failure every time.
#:
#: ``failed`` is a previewed unreadable outcome with a concrete `_corrupted/`
#: destination. It must be frozen like every other reviewed placement; the run
#: reports it as ``corrupted`` once that protective copy/move succeeds.
PLANNED_QUARANTINE_STATUSES = frozenset(
    {
        "already_in_destination",
        "duplicate",
        "failed",
        "future_date",
        "junk",
        # No usable date, and the EXIF that was there failed the sanity check.
        # The preview sends it to `_undated/` exactly like `unknown_date`,
        # so it needs exactly the same planned action.
        "suspicious_date",
        "unknown_date",
    }
)


def source_fingerprint(path: Path) -> str:
    """Versioned non-destructive hint used only to detect preview drift."""
    observed = path.stat()
    return (
        "v2:cache_hint:"
        f"{observed.st_size}:{observed.st_mtime_ns}:"
        f"{getattr(observed, 'st_ctime_ns', 0)}:{observed.st_ino}"
    )


class FrozenSortAction(BaseModel):
    model_config = ConfigDict(frozen=True)

    source_path: str
    source_fingerprint: str
    destination_path: str
    reviewed_destination_path: str
    kind: MutationActionKind
    source_effect: SourceEffect
    expected_size_bytes: int = Field(ge=0)
    disposition: PlannedDisposition
    unit_id: str | None = None
    companion_role: str | None = None
    provenance: OutcomeProvenance | None = None
    #: The explanation for this file's own destination before duplicate
    #: placement made it follow a keeper. Needed when Review promotes a copy.
    would_be_provenance: OutcomeProvenance | None = None
    #: Audit context for keeper-relative placement. Optional for old plans.
    source_root: str | None = None
    destination_root: str | None = None
    resolved_date: str | None = None
    would_be_destination_path: str | None = None
    keeper_path: str | None = None

    @property
    def identity(self) -> str:
        payload = (
            self.source_path,
            self.destination_path,
            self.kind,
            self.source_effect,
            self.unit_id,
            self.companion_role,
        )
        return hashlib.sha256(repr(payload).encode("utf-8")).hexdigest()


class FrozenSortImpact(BaseModel):
    model_config = ConfigDict(frozen=True)

    actionable_groups: int
    copy_count: int
    move_count: int
    quarantine_count: int
    quarantine_bytes: int
    skip_count: int
    source_mutations: int
    required_bytes: int
    conversion_without_originals: int
    companions_left_in_place: int
    embedded_tag_count: int
    unresolved_count: int


class ReviewedSet(BaseModel):
    """One duplicate set, and which copy Review decided to keep.

    Set-level rather than hash-keyed because the swap needs both sides. Nothing
    in a frozen action carries a content hash — `source_fingerprint` is a cache
    hint (size, mtime, ctime, inode), deliberately not proof of content — so
    `{sha256: path}` could name the winner but never the losers whose actions
    have to change with it.
    """

    model_config = ConfigDict(frozen=True)

    keep: str
    demote: tuple[str, ...] = ()
    #: The user decided these files are independent rather than copies. ``keep``
    #: remains the stable representative and ``demote`` carries the rest of the
    #: complete set, but no member is demoted when this flag is true.
    keep_all: bool = False


class FrozenSortPlan(BaseModel):
    model_config = ConfigDict(frozen=True)

    plan_id: str
    config_fingerprint: str
    actions: tuple[FrozenSortAction, ...]
    impact: FrozenSortImpact
    #: The keeper Review chose for each duplicate set it decided, applied to a
    #: derived plan by `with_reviewed_sets`. One run's decisions, never the
    #: stored plan's.
    reviewed_sets: tuple[ReviewedSet, ...] = ()
    #: Counters the item scan produced: a file the preview skipped stays
    #: skipped, and one it could not resolve stays unresolved.
    skip_count: int = 0
    unresolved_count: int = 0
    companions_left_in_place: int = 0
    #: The three configuration answers the impact depends on, carried so a
    #: derived plan can recompute its own impact without the Config.
    copy_mode: bool = True
    converts_media: bool = False
    embeds_tags: bool = False

    def action_map(self) -> dict[str, FrozenSortAction]:
        return {action.identity: action for action in self.actions}

    def with_reviewed_sets(
        self,
        sets: Sequence[ReviewedSet],
        *,
        source_root: Path | str,
    ) -> FrozenSortPlan:
        """A new plan in which Review's chosen copy is the one that gets placed.

        The run derives every destination itself, so a plan that merely *said*
        the other copy wins would be a plan the run then contradicts — and
        `FrozenPlanGuard` would abort it as an unplanned action. This therefore
        rewrites the complete set into exactly what a run seeded with the same
        decision will compute: the chosen copy takes its own predicted outcome,
        every other member follows it into an adjacent ``_copies`` leaf, and
        companions follow their primary.

        The stored plan is never mutated. Decisions belong to one run.
        """
        if not sets:
            return self
        root = Path(source_root)
        by_source: dict[str, list[int]] = {}
        for index, action in enumerate(self.actions):
            by_source.setdefault(action.source_path, []).append(index)

        rewritten = list(self.actions)
        for reviewed in sets:
            keeper_index = _primary_index(rewritten, by_source, reviewed.keep)
            group_indices = [
                _primary_index(rewritten, by_source, source)
                for source in dict.fromkeys((reviewed.keep, *reviewed.demote))
            ]
            if reviewed.keep_all:
                rewritten = _rewrite_distinct_set(
                    rewritten,
                    group_indices,
                    copy_mode=self.copy_mode,
                )
                continue

            planned_index = _planned_keeper_index(rewritten, by_source, reviewed)
            if planned_index is None or planned_index == keeper_index:
                # Already the keeper, or the set holds nothing else to demote.
                continue
            promoted = rewritten[keeper_index]
            for group_index in group_indices:
                if group_index != keeper_index:
                    _refuse_incompatible_units(
                        rewritten,
                        promoted,
                        rewritten[group_index],
                    )
            rewritten = _rewrite_reviewed_set(
                rewritten,
                group_indices,
                keeper_index,
                planned_index,
                root,
            )

        derived = self.model_copy(
            update={"actions": tuple(rewritten), "reviewed_sets": tuple(sets)}
        )
        return derived.model_copy(update={"impact": derived._impact()})

    def _impact(self) -> FrozenSortImpact:
        return build_impact(
            self.actions,
            skip_count=self.skip_count,
            unresolved_count=self.unresolved_count,
            companions_left_in_place=self.companions_left_in_place,
            copy_mode=self.copy_mode,
            converts_media=self.converts_media,
            embeds_tags=self.embeds_tags,
        )


def _primary_index(
    actions: Sequence[FrozenSortAction],
    by_source: dict[str, list[int]],
    source: str,
) -> int:
    """The reviewed file's own action, never one of its companions."""
    for index in by_source.get(source, ()):
        if actions[index].companion_role is None:
            return index
    raise ConflictError(
        "A reviewed duplicate names a file the plan has no action for; generate preview again.",
        details={"reason": "unplanned_review_decision", "source_path": source},
    )


def _planned_keeper_index(
    actions: Sequence[FrozenSortAction],
    by_source: dict[str, list[int]],
    reviewed: ReviewedSet,
) -> int | None:
    """Return the member that every currently planned copy follows."""
    members = (reviewed.keep, *reviewed.demote)
    referenced_keepers = {
        actions[_primary_index(actions, by_source, source)].keeper_path for source in members
    }
    for source in members:
        if source in referenced_keepers:
            return _primary_index(actions, by_source, source)

    # Backward-compatible fallback for plans created before keeper_path was
    # recorded. A normal dated keeper is the one sortable primary in the set.
    for source in (reviewed.keep, *reviewed.demote):
        index = _primary_index(actions, by_source, source)
        if actions[index].disposition == "sort":
            return index
    # An undated/junk keeper is itself set aside, so no member is sortable. It
    # is still the only primary that is not recorded as following another copy.
    for source in members:
        index = _primary_index(actions, by_source, source)
        if actions[index].keeper_path is None:
            return index
    return None


def _companion_roles(actions: Sequence[FrozenSortAction], unit_id: str | None) -> list[str]:
    """Every companion travelling with one unit, by role."""
    if unit_id is None:
        return []
    return sorted(
        action.companion_role
        for action in actions
        if action.unit_id == unit_id and action.companion_role is not None
    )


def _refuse_incompatible_units(
    actions: Sequence[FrozenSortAction],
    promoted: FrozenSortAction,
    demoted: FrozenSortAction,
) -> None:
    """Refuse a swap whose two sides do not carry the same companion files.

    A RAW+JPEG pair demoted under a lone JPEG would leave its sidecar bound to a
    primary that is now set aside as a copy. Half-swapping is worse than refusing:
    the user believes the set is resolved either way, and only one of those two
    beliefs can still be corrected.

    Duplicate primaries retain their unit ids, so both sides can be compared and
    their companions can be rewritten atomically with the selected primary.
    """
    promoted_roles = _companion_roles(actions, promoted.unit_id)
    demoted_roles = _companion_roles(actions, demoted.unit_id)
    if promoted_roles != demoted_roles:
        raise ConflictError(
            "These copies do not carry the same companion files, so one cannot take "
            "the other's place; exclude one of them instead.",
            details={
                "reason": "incompatible_companions",
                "source_path": promoted.source_path,
                "conflicting_path": demoted.source_path,
            },
        )


def _unit_indices(actions: Sequence[FrozenSortAction], primary_indices: Sequence[int]) -> set[int]:
    """Return primaries plus every companion attached to one of their units."""
    unit_ids = {
        actions[index].unit_id for index in primary_indices if actions[index].unit_id is not None
    }
    return {
        index
        for index, action in enumerate(actions)
        if index in primary_indices or (action.unit_id is not None and action.unit_id in unit_ids)
    }


def _is_root_set_aside_destination(path: Path) -> bool:
    """Whether a keeper's own outcome is one of the three root categories."""
    root_folders = frozenset(QUARANTINE_FOLDERS.values())
    return any(part in root_folders for part in path.parts)


def _keeper_provenance(action: FrozenSortAction) -> OutcomeProvenance | None:
    """Restore the selected member's own explanation and duplicate status."""
    provenance = action.would_be_provenance or action.provenance
    if provenance is None:
        return None
    duplicate = provenance.duplicate.model_copy(
        update={
            "status": "unique",
            "match_kind": None,
            "matched_path": None,
            "perceptual_distance": None,
        }
    )
    return provenance.model_copy(update={"duplicate": duplicate})


def _rewrite_reviewed_set(
    actions: Sequence[FrozenSortAction],
    primary_indices: Sequence[int],
    keeper_index: int,
    planned_keeper_index: int,
    source_root: Path,
) -> list[FrozenSortAction]:
    """Rewrite a complete duplicate set around Review's selected keeper.

    The selected file uses the own destination recorded during preview. Every
    loser is then derived from that exact path with the same shared reservation
    function used by preview and execution. This works across dates, input
    folders, and root set-aside categories without guessing configuration.
    """
    rewritten = list(actions)
    affected = _unit_indices(actions, primary_indices)
    reserved = {
        Path(action.reviewed_destination_path).resolve(strict=False)
        for index, action in enumerate(actions)
        if index not in affected
    }

    selected = actions[keeper_index]
    own_destination = Path(selected.would_be_destination_path or selected.reviewed_destination_path)
    keeper_destination = reserve_destination(own_destination, reserved)
    keeper_is_set_aside = _is_root_set_aside_destination(keeper_destination)
    reviewed_keeper = selected.model_copy(
        update={
            "destination_path": str(
                keeper_destination
                if keeper_is_set_aside
                else keeper_destination.with_suffix(Path(selected.source_path).suffix)
            ),
            "reviewed_destination_path": str(keeper_destination),
            "kind": (
                "quarantine"
                if keeper_is_set_aside
                else (
                    "copy" if actions[planned_keeper_index].source_effect == "retained" else "move"
                )
            ),
            "source_effect": actions[planned_keeper_index].source_effect,
            "disposition": "quarantine" if keeper_is_set_aside else "sort",
            "keeper_path": None,
            "provenance": _keeper_provenance(selected),
        }
    )
    rewritten[keeper_index] = reviewed_keeper

    loser_indices = sorted(
        (index for index in primary_indices if index != keeper_index),
        key=lambda index: actions[index].source_path,
    )
    for loser_index in loser_indices:
        loser = actions[loser_index]
        loser_root = Path(loser.source_root or source_root)
        proposed = copy_destination(
            keeper_destination,
            Path(selected.source_path),
            Path(loser.source_path),
            loser_root,
        )
        copy_path = reserve_destination(proposed, reserved)
        provenance = (
            contextualize_copy(
                loser.provenance,
                destination=copy_path,
                destination_root=Path(
                    loser.destination_root
                    or selected.destination_root
                    or _destination_root(keeper_destination)
                ),
                keeper=Path(selected.source_path),
            )
            if loser.provenance is not None
            else None
        )
        rewritten[loser_index] = loser.model_copy(
            update={
                "destination_path": str(copy_path),
                "reviewed_destination_path": str(copy_path),
                "kind": "quarantine",
                "disposition": "quarantine",
                "keeper_path": selected.source_path,
                "provenance": provenance,
            }
        )

    for primary_index in primary_indices:
        primary = rewritten[primary_index]
        if primary.unit_id is None:
            continue
        for index in affected:
            companion = rewritten[index]
            if companion.unit_id != primary.unit_id or companion.companion_role is None:
                continue
            destination = companion_destination(
                Path(primary.reviewed_destination_path),
                Path(companion.source_path),
            )
            rewritten[index] = companion.model_copy(
                update={
                    "destination_path": str(destination),
                    "reviewed_destination_path": str(destination),
                    "keeper_path": primary.keeper_path,
                }
            )
    return rewritten


def _rewrite_distinct_set(
    actions: Sequence[FrozenSortAction],
    primary_indices: Sequence[int],
    *,
    copy_mode: bool,
) -> list[FrozenSortAction]:
    """Restore every member's own reviewed destination for a keep-all answer.

    Preview already recorded the independent destination before duplicate
    placement made a copy follow its keeper. Reusing that record is both more
    accurate and safer than re-running rules during execution. Reservations are
    rebuilt across the whole set so two independent files that want one name
    still receive the deterministic collision suffix the preview contract uses.
    """
    rewritten = list(actions)
    affected = _unit_indices(actions, primary_indices)
    reserved = {
        Path(action.reviewed_destination_path).resolve(strict=False)
        for index, action in enumerate(actions)
        if index not in affected
    }

    for primary_index in sorted(primary_indices, key=lambda index: actions[index].source_path):
        action = actions[primary_index]
        own = Path(action.would_be_destination_path or action.reviewed_destination_path)
        reviewed_destination = reserve_destination(own, reserved)
        set_aside = _is_root_set_aside_destination(reviewed_destination)
        rewritten[primary_index] = action.model_copy(
            update={
                "destination_path": str(
                    reviewed_destination
                    if set_aside
                    else reviewed_destination.with_suffix(Path(action.source_path).suffix)
                ),
                "reviewed_destination_path": str(reviewed_destination),
                "kind": "quarantine" if set_aside else ("copy" if copy_mode else "move"),
                "source_effect": "retained" if copy_mode else "remove_after_verification",
                "disposition": "quarantine" if set_aside else "sort",
                "keeper_path": None,
                "provenance": _keeper_provenance(action),
            }
        )

    for primary_index in primary_indices:
        primary = rewritten[primary_index]
        if primary.unit_id is None:
            continue
        for index in affected:
            companion = rewritten[index]
            if companion.unit_id != primary.unit_id or companion.companion_role is None:
                continue
            destination = companion_destination(
                Path(primary.reviewed_destination_path),
                Path(companion.source_path),
            )
            rewritten[index] = companion.model_copy(
                update={
                    "destination_path": str(destination),
                    "reviewed_destination_path": str(destination),
                    "keeper_path": None,
                }
            )
    return rewritten


def _destination_root(destination: Path) -> Path:
    """Best-effort root used only to make contextual provenance relative."""
    parts = destination.parts
    markers = (*sorted(set(QUARANTINE_FOLDERS.values())), CONTEXTUAL_COPY_FOLDER)
    for marker in markers:
        if marker in parts:
            return Path(*parts[: parts.index(marker)])
    # For an ordinary dated path there is no self-describing root boundary.
    # Returning the anchor preserves every segment and never misattributes it.
    return Path(destination.anchor)


def build_impact(
    actions: Sequence[FrozenSortAction],
    *,
    skip_count: int,
    unresolved_count: int,
    companions_left_in_place: int,
    copy_mode: bool,
    converts_media: bool,
    embeds_tags: bool,
) -> FrozenSortImpact:
    """Describe exactly the given actions.

    The one place these totals are produced, so a stored plan and a plan derived
    from duplicate decisions cannot count differently.
    """
    quarantines = [action for action in actions if action.kind == "quarantine"]
    sortable_primaries = sum(
        action.disposition == "sort" and action.companion_role is None for action in actions
    )
    return FrozenSortImpact(
        # A count of reviewed primary files the run will act on, not a flag.
        # Companions are separate actions but remain part of their primary's
        # group, so preflight must not count them twice.
        actionable_groups=sum(action.companion_role is None for action in actions),
        copy_count=sum(action.kind == "copy" for action in actions),
        move_count=sum(action.kind == "move" for action in actions),
        quarantine_count=len(quarantines),
        quarantine_bytes=sum(action.expected_size_bytes for action in quarantines),
        skip_count=skip_count,
        source_mutations=sum(action.source_effect != "retained" for action in actions),
        required_bytes=(sum(action.expected_size_bytes for action in actions) if copy_mode else 0),
        conversion_without_originals=(
            sortable_primaries if not copy_mode and converts_media else 0
        ),
        companions_left_in_place=companions_left_in_place,
        embedded_tag_count=sortable_primaries if embeds_tags else 0,
        unresolved_count=unresolved_count,
    )


def build_frozen_sort_plan(
    items: list[dict[str, Any]],
    config: Config,
) -> FrozenSortPlan:
    """Freeze preview outcomes and derive their impact from those same actions."""
    actions: list[FrozenSortAction] = []
    skipped = 0
    unresolved = 0
    companions_left = 0
    quarantine_statuses = PLANNED_QUARANTINE_STATUSES
    for item in items:
        status = str(item.get("status") or "")
        destination = item.get("destination")
        source = item.get("source")
        if status == "duplicate_unknown":
            unresolved += 1
        elif not source or not destination or status not in {"sort", *quarantine_statuses}:
            skipped += 1
        if source and destination and status in {"sort", *quarantine_statuses}:
            source_path = Path(str(source))
            reviewed_destination = Path(str(destination))
            # Conversion happens only after a byte-identical verified placement.
            # The transfer executor therefore authorizes the source-suffix
            # staging name while provenance continues to explain the final name.
            transfer_destination = (
                reviewed_destination.with_suffix(source_path.suffix)
                if status == "sort"
                else reviewed_destination
            )
            action_kind: MutationActionKind = (
                "quarantine"
                if status in quarantine_statuses
                else ("copy" if config.copy_instead_of_move else "move")
            )
            provenance = item.get("provenance")
            actions.append(
                FrozenSortAction(
                    source_path=str(source_path),
                    source_fingerprint=source_fingerprint(source_path),
                    destination_path=str(transfer_destination),
                    reviewed_destination_path=str(reviewed_destination),
                    kind=action_kind,
                    source_effect=(
                        "retained" if config.copy_instead_of_move else "remove_after_verification"
                    ),
                    expected_size_bytes=int(item.get("file_size") or 0),
                    disposition="quarantine" if status in quarantine_statuses else "sort",
                    unit_id=item.get("unit_id"),
                    provenance=(
                        OutcomeProvenance.model_validate(provenance)
                        if isinstance(provenance, dict)
                        else None
                    ),
                    would_be_provenance=(
                        OutcomeProvenance.model_validate(item["would_be_provenance"])
                        if isinstance(item.get("would_be_provenance"), dict)
                        else None
                    ),
                    source_root=str(item.get("source_root") or config.source_directory),
                    destination_root=str(config.target_directory),
                    resolved_date=(
                        str(item["extracted_date"])
                        if item.get("extracted_date") is not None
                        else None
                    ),
                    would_be_destination_path=str(
                        item.get("would_be_destination") or reviewed_destination
                    ),
                    keeper_path=(
                        str(item["duplicate_of"]) if item.get("duplicate_of") is not None else None
                    ),
                )
            )
        for companion in item.get("companions") or []:
            if companion.get("status") == "left_in_place":
                companions_left += 1
                continue
            companion_source = companion.get("source")
            companion_destination = companion.get("destination")
            if not companion_source or not companion_destination:
                continue
            source_path = Path(str(companion_source))
            try:
                companion_size = source_path.stat().st_size
                companion_fingerprint = source_fingerprint(source_path)
            except OSError:
                # A scan and a preview are not the same instant. A sidecar that
                # went in between is one companion the run cannot place, not a
                # reason to lose the whole preview — and freezing an action for
                # a file that is gone would only fail later, at the transfer.
                companions_left += 1
                continue
            actions.append(
                FrozenSortAction(
                    source_path=str(source_path),
                    source_fingerprint=companion_fingerprint,
                    destination_path=str(companion_destination),
                    reviewed_destination_path=str(companion_destination),
                    kind="copy" if config.copy_instead_of_move else "move",
                    source_effect=(
                        "retained" if config.copy_instead_of_move else "remove_after_verification"
                    ),
                    expected_size_bytes=companion_size,
                    disposition="sort",
                    unit_id=item.get("unit_id"),
                    companion_role=companion.get("role"),
                    source_root=str(item.get("source_root") or config.source_directory),
                    destination_root=str(config.target_directory),
                    resolved_date=(
                        str(companion["extracted_date"])
                        if companion.get("extracted_date") is not None
                        else None
                    ),
                    would_be_destination_path=str(companion_destination),
                    keeper_path=(
                        str(item["duplicate_of"])
                        if status == "duplicate" and item.get("duplicate_of") is not None
                        else None
                    ),
                )
            )

    converts_media = config.convert_images or config.convert_videos
    return FrozenSortPlan(
        plan_id=f"sortplan_{uuid.uuid4().hex[:20]}",
        config_fingerprint=config_fingerprint(config),
        actions=tuple(actions),
        impact=build_impact(
            actions,
            skip_count=skipped,
            unresolved_count=unresolved,
            companions_left_in_place=companions_left,
            copy_mode=config.copy_instead_of_move,
            converts_media=converts_media,
            embeds_tags=config.embed_tags_in_files,
        ),
        skip_count=skipped,
        unresolved_count=unresolved,
        companions_left_in_place=companions_left,
        copy_mode=config.copy_instead_of_move,
        converts_media=converts_media,
        embeds_tags=config.embed_tags_in_files,
    )


class FrozenPlanGuard:
    """Mutable consumption state around an immutable plan."""

    def __init__(self, plan: FrozenSortPlan) -> None:
        self.plan = plan
        self._remaining = plan.action_map()

    def authorize(
        self,
        source: Path,
        destination: Path,
        *,
        kind: MutationActionKind,
        move: bool,
        unit_id: str | None,
        companion_role: str | None,
    ) -> FrozenSortAction:
        """Return the exact planned action or refuse the mutation."""
        source_effect: SourceEffect = "remove_after_verification" if move else "retained"
        candidate = FrozenSortAction(
            source_path=str(source),
            source_fingerprint=source_fingerprint(source),
            destination_path=str(destination),
            reviewed_destination_path=str(destination),
            kind=kind,
            source_effect=source_effect,
            expected_size_bytes=source.stat().st_size,
            disposition="quarantine" if kind == "quarantine" else "sort",
            unit_id=unit_id,
            companion_role=companion_role,
        )
        planned = self._remaining.get(candidate.identity)
        if planned is None:
            raise PlanAuthorizationError(
                "The executable action differs from the reviewed plan; generate preview again.",
                reason="unplanned_action",
                source_path=str(source),
                destination_path=str(destination),
            )
        if planned.source_fingerprint != candidate.source_fingerprint:
            raise PlanAuthorizationError(
                "A planned source changed after preview; generate preview again.",
                reason="source_changed",
                source_path=str(source),
            )
        if planned.expected_size_bytes != candidate.expected_size_bytes:
            raise PlanAuthorizationError(
                "A planned source changed size after preview; generate preview again.",
                reason="source_resized",
                source_path=str(source),
            )
        self._remaining.pop(candidate.identity)
        return planned

    def verify_final_destination(
        self,
        source: Path,
        destination: Path,
        *,
        unit_id: str | None,
        companion_role: str | None,
    ) -> None:
        """Refuse a recomputed final path that differs from the reviewed path."""
        planned = next(
            (
                action
                for action in self._remaining.values()
                if action.source_path == str(source)
                and action.unit_id == unit_id
                and action.companion_role == companion_role
            ),
            None,
        )
        if planned is None or planned.reviewed_destination_path != str(destination):
            raise PlanAuthorizationError(
                "The final destination differs from the reviewed plan; generate preview again.",
                reason="destination_changed",
                source_path=str(source),
                destination_path=str(destination),
            )

    @property
    def remaining(self) -> tuple[FrozenSortAction, ...]:
        return tuple(self._remaining.values())
