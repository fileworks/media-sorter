"""Frozen preview plan consumed by the sort executor.

The preview is the point at which a user reviews destinations and consequences.
This contract keeps those decisions immutable and gives the transfer boundary a
small, exact authorization record to check before it writes anything.
"""

from __future__ import annotations

import hashlib
import uuid
from pathlib import Path
from typing import Any, Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.integrity import MutationActionKind, SourceEffect
from app.core.provenance import OutcomeProvenance

PlannedDisposition = Literal[
    "sort",
    "quarantine",
]


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

    def action_map(self) -> dict[str, FrozenSortAction]:
        return {action.identity: action for action in self.actions}


def build_frozen_sort_plan(
    items: list[dict[str, Any]],
    config: Config,
) -> FrozenSortPlan:
    """Freeze preview outcomes and derive their impact from those same actions."""
    actions: list[FrozenSortAction] = []
    skipped = 0
    unresolved = 0
    companions_left = 0
    quarantine_statuses = {
        "junk",
        "unknown_date",
        "future_date",
        "duplicate",
        "already_in_destination",
    }
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
            actions.append(
                FrozenSortAction(
                    source_path=str(source_path),
                    source_fingerprint=source_fingerprint(source_path),
                    destination_path=str(companion_destination),
                    reviewed_destination_path=str(companion_destination),
                    kind="copy" if config.copy_instead_of_move else "move",
                    source_effect=(
                        "retained" if config.copy_instead_of_move else "remove_after_verification"
                    ),
                    expected_size_bytes=source_path.stat().st_size,
                    disposition="sort",
                    unit_id=item.get("unit_id"),
                    companion_role=companion.get("role"),
                )
            )

    copy_count = sum(action.kind == "copy" for action in actions)
    move_count = sum(action.kind == "move" for action in actions)
    quarantines = [action for action in actions if action.kind == "quarantine"]
    source_mutations = sum(action.source_effect != "retained" for action in actions)
    sortable_primaries = sum(
        action.disposition == "sort" and action.companion_role is None for action in actions
    )
    return FrozenSortPlan(
        plan_id=f"sortplan_{uuid.uuid4().hex[:20]}",
        config_fingerprint=config_fingerprint(config),
        actions=tuple(actions),
        impact=FrozenSortImpact(
            actionable_groups=1 if actions else 0,
            copy_count=copy_count,
            move_count=move_count,
            quarantine_count=len(quarantines),
            quarantine_bytes=sum(action.expected_size_bytes for action in quarantines),
            skip_count=skipped,
            source_mutations=source_mutations,
            required_bytes=(
                sum(action.expected_size_bytes for action in actions)
                if config.copy_instead_of_move
                else 0
            ),
            conversion_without_originals=(
                sortable_primaries
                if not config.copy_instead_of_move
                and (config.convert_images or config.convert_videos)
                else 0
            ),
            companions_left_in_place=companions_left,
            embedded_tag_count=sortable_primaries if config.embed_tags_in_files else 0,
            unresolved_count=unresolved,
        ),
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
            raise ValueError(
                "The executable action differs from the reviewed plan; generate preview again."
            )
        if planned.source_fingerprint != candidate.source_fingerprint:
            raise ValueError("A planned source changed after preview; generate preview again.")
        if planned.expected_size_bytes != candidate.expected_size_bytes:
            raise ValueError("A planned source changed size after preview; generate preview again.")
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
            raise ValueError(
                "The final destination differs from the reviewed plan; generate preview again."
            )

    @property
    def remaining(self) -> tuple[FrozenSortAction, ...]:
        return tuple(self._remaining.values())
