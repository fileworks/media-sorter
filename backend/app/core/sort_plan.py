"""Frozen preview plan consumed by the sort executor.

The preview is the point at which a user reviews destinations and consequences.
This contract keeps those decisions immutable and gives the transfer boundary a
small, exact authorization record to check before it writes anything.
"""

from __future__ import annotations

import hashlib
import uuid
from collections.abc import Iterable, Sequence
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.exceptions import PlanAuthorizationError
from app.core.integrity import MutationActionKind, SourceEffect
from app.core.provenance import OutcomeProvenance

PlannedDisposition = Literal[
    "sort",
    "quarantine",
]

#: Preview statuses that carry a review-folder destination.
#:
#: This is the one list, read rather than restated wherever the question "does
#: this file go to a review folder?" is asked — `preview_service` derives its
#: own set from it, and `reviewStatuses.test.ts` pins the frontend to it.
#: Restating it was how `suspicious_date` came to be previewed into
#: `_unknown_dates/` while the plan authorized nothing: the run then reached the
#: whitelist with an unplanned placement, recorded the file as *failed*, and
#: told the user to generate the preview again — which produced the same plan
#: and the same failure every time.
#:
#: `failed` and `corrupted` are deliberately absent: they are outcomes the sort
#: discovers while running, never statuses the preview freezes into a plan.
PLANNED_QUARANTINE_STATUSES = frozenset(
    {
        "already_in_destination",
        "duplicate",
        "future_date",
        "junk",
        # No usable date, and the EXIF that was there failed the sanity check.
        # The preview sends it to `_unknown_dates/` exactly like `unknown_date`,
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


class FrozenSortPlan(BaseModel):
    model_config = ConfigDict(frozen=True)

    plan_id: str
    config_fingerprint: str
    actions: tuple[FrozenSortAction, ...]
    impact: FrozenSortImpact
    #: Content hash → the path Review chose to keep for that content. Seeding
    #: the run's duplicate registry with these makes the reviewed copy the
    #: "first seen" one, which is the same mechanism the configured policy uses
    #: — so a reviewed keeper wins without a second, parallel notion of keeping.
    reviewed_keepers: dict[str, str] = Field(default_factory=dict)
    #: Sources Review excluded from this run. They are skipped before anything
    #: touches them, and are not failures — the plan is unchanged, a derived
    #: copy of it simply declines to act on these.
    skipped_sources: frozenset[str] = frozenset()
    #: Counters the item scan produced, which no exclusion can change: a file
    #: the preview skipped stays skipped, and one it could not resolve stays
    #: unresolved.
    skip_count: int = 0
    unresolved_count: int = 0
    companions_left_in_place: int = 0
    #: The three configuration answers the impact depends on, carried so a
    #: derived plan can recompute its own impact without the Config.
    copy_mode: bool = True
    converts_media: bool = False
    embeds_tags: bool = False

    @property
    def live_actions(self) -> tuple[FrozenSortAction, ...]:
        """The actions this plan will actually perform, exclusions applied."""
        return tuple(
            action for action in self.actions if action.source_path not in self.skipped_sources
        )

    def action_map(self) -> dict[str, FrozenSortAction]:
        return {action.identity: action for action in self.actions}

    def is_skipped(self, source: Path | str) -> bool:
        return str(source) in self.skipped_sources

    def with_reviewed_keepers(self, keepers: dict[str, str]) -> FrozenSortPlan:
        """A new plan carrying Review's keeper choices. The stored plan is untouched."""
        return self.model_copy(update={"reviewed_keepers": dict(keepers)})

    def with_exclusions(self, sources: Iterable[str]) -> FrozenSortPlan:
        """A new plan that declines the given sources, expanded to whole units.

        Excluding one half of a RAW+JPEG pair would leave the other half moving
        on its own, so a companion drags its unit with it. The stored plan is
        never mutated: the exclusions belong to one run, not to the plan.
        """
        requested = {str(source) for source in sources}
        units = {
            action.unit_id
            for action in self.actions
            if action.unit_id is not None and action.source_path in requested
        }
        expanded = {
            action.source_path
            for action in self.actions
            if action.source_path in requested
            or (action.unit_id is not None and action.unit_id in units)
        }
        derived = self.model_copy(update={"skipped_sources": frozenset(expanded)})
        # The impact has to describe the run that will happen. Leaving the
        # original totals here is what made the Execute preflight subtract a
        # per-reviewed-file tally from action-level counts: excluding a RAW+JPEG
        # pair took one file and the JPEG's bytes off a total holding two files
        # and both, so it promised a copy that would never happen.
        return derived.model_copy(update={"impact": derived._impact()})

    def _impact(self) -> FrozenSortImpact:
        return build_impact(
            self.live_actions,
            skip_count=self.skip_count,
            unresolved_count=self.unresolved_count,
            companions_left_in_place=self.companions_left_in_place,
            copy_mode=self.copy_mode,
            converts_media=self.converts_media,
            embeds_tags=self.embeds_tags,
        )


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

    The one place these totals are produced, so a plan and the plan derived from
    it by excluding sources cannot count differently.
    """
    quarantines = [action for action in actions if action.kind == "quarantine"]
    sortable_primaries = sum(
        action.disposition == "sort" and action.companion_role is None for action in actions
    )
    return FrozenSortImpact(
        # A count of reviewed files the run will act on, not a flag. The Execute
        # preflight refuses to start at zero, so `1 if actions else 0` meant
        # excluding a single file blocked a run of any size. Companions are not
        # counted: an exclusion is expressed per reviewed file, and its unit
        # follows it.
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
        if status in {"failed", "duplicate_unknown"}:
            unresolved += 1
        elif status not in {"sort", *quarantine_statuses}:
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
                    unit_id=None if status in quarantine_statuses else item.get("unit_id"),
                    provenance=(
                        OutcomeProvenance.model_validate(provenance)
                        if isinstance(provenance, dict)
                        else None
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
        self.skipped_sources = plan.skipped_sources

    def authorize(
        self,
        source: Path,
        destination: Path,
        *,
        kind: MutationActionKind,
        move: bool,
        unit_id: str | None,
        companion_role: str | None,
    ) -> FrozenSortAction | None:
        """The planned action, or ``None`` when Review excluded this source.

        A skip is not a whitelist violation: the source *is* in the plan, and the
        user decided not to act on it. Every other path through the whitelist is
        unchanged — an unplanned action still raises.
        """
        if str(source) in self.skipped_sources:
            return None
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
