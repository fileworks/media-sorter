"""Deciding what an interrupted operation may reuse when it starts again.

Resuming is only safe when the world the checkpoint was written in still
exists: the same profile, the same roots, the same catalog schema, the same
algorithm versions. When any of those moved, the expensive stages that depended
on them are invalidated — individually, with a reason, so a user is told which
work is being redone rather than watching the whole scan start over in silence.

Nothing here deletes anything. An invalidated stage is recomputed; the catalog
keeps whatever is still provably valid.
"""

from __future__ import annotations

import json
from collections.abc import Mapping, Sequence
from dataclasses import dataclass, field
from typing import Literal

from app.core.library_profiles import DurableCheckpoint
from app.core.logging_config import get_logger
from app.services.catalog import MediaCatalog

logger = get_logger(__name__)

#: Stages an operation can reuse, cheapest to most expensive to redo.
Stage = Literal["discovery", "hashing", "media_facts", "signatures", "thumbnails", "planning"]

STAGES: tuple[Stage, ...] = (
    "discovery",
    "hashing",
    "media_facts",
    "signatures",
    "thumbnails",
    "planning",
)

#: Which stage each algorithm version governs. A changed extractor invalidates
#: its own stage and everything derived from it, and nothing else.
STAGE_BY_ALGORITHM: Mapping[str, Stage] = {
    "hash": "hashing",
    "media_facts": "media_facts",
    "signature": "signatures",
    "thumbnail": "thumbnails",
    "planner": "planning",
}

Decision = Literal["resume", "restart", "start_fresh"]


@dataclass(frozen=True)
class Invalidation:
    """One stage that cannot be reused, and the reason a user will read."""

    stage: Stage
    reason: str


@dataclass(frozen=True)
class ResumePlan:
    """What the next run will reuse, redo, and tell the user about."""

    decision: Decision
    checkpoint: DurableCheckpoint | None
    reusable: tuple[Stage, ...] = ()
    invalidated: tuple[Invalidation, ...] = ()
    blocked_reason: str | None = None

    @property
    def explanations(self) -> tuple[str, ...]:
        return tuple(f"{item.stage}: {item.reason}" for item in self.invalidated)

    @property
    def reuses_expensive_work(self) -> bool:
        return any(stage in self.reusable for stage in ("hashing", "signatures", "thumbnails"))


def save_checkpoint(catalog: MediaCatalog, checkpoint: DurableCheckpoint, *, cursor: int) -> None:
    """Persist a checkpoint after a bounded batch has already committed.

    Order matters: the batch is durable first, the checkpoint second. A crash
    between them costs one batch of repeated work, which is recoverable. The
    reverse order would claim work that never landed.
    """
    catalog.save_checkpoint(
        checkpoint.operation_id,
        cursor=cursor,
        root_id=None,
        phase=checkpoint.phase,
        payload=checkpoint.model_dump_json(),
    )


def load_checkpoint(catalog: MediaCatalog, operation_id: str) -> DurableCheckpoint | None:
    """Read a checkpoint back, treating an unreadable one as absent.

    A damaged checkpoint must never abort a run: the correct response to "I
    cannot tell what was done" is to do it again, not to refuse to work.
    """
    row = catalog.checkpoint(operation_id)
    if row is None or not row.get("payload"):
        return None
    try:
        return DurableCheckpoint.model_validate(json.loads(str(row["payload"])))
    except (json.JSONDecodeError, ValueError) as exc:
        logger.warning(
            "Ignoring an unreadable checkpoint",
            operation_id=operation_id,
            error=str(exc),
        )
        return None


def plan_resume(
    checkpoint: DurableCheckpoint | None,
    *,
    profile_id: str,
    profile_schema_version: int,
    catalog_schema_version: int,
    algorithm_versions: Mapping[str, str],
    known_root_ids: Sequence[str] = (),
) -> ResumePlan:
    """Decide what may be reused, one stage at a time.

    A different profile or a newer catalog schema invalidates everything —
    those change what the stored work *means*. A changed algorithm invalidates
    only the stage it governs and the stages downstream of it, because the
    earlier ones were computed from inputs that did not move.
    """
    if checkpoint is None:
        return ResumePlan(decision="start_fresh", checkpoint=None, reusable=STAGES)

    if checkpoint.profile_id != profile_id:
        return ResumePlan(
            decision="restart",
            checkpoint=checkpoint,
            invalidated=tuple(
                Invalidation(stage, "the saved work belongs to a different profile")
                for stage in STAGES
            ),
            blocked_reason="the saved work belongs to a different profile",
        )
    if checkpoint.profile_schema_version != profile_schema_version:
        return ResumePlan(
            decision="restart",
            checkpoint=checkpoint,
            invalidated=tuple(
                Invalidation(stage, "the profile format changed since this work was saved")
                for stage in STAGES
            ),
            blocked_reason="the profile format changed since this work was saved",
        )
    if checkpoint.catalog_schema_version != catalog_schema_version:
        return ResumePlan(
            decision="restart",
            checkpoint=checkpoint,
            invalidated=tuple(
                Invalidation(stage, "the index format changed since this work was saved")
                for stage in STAGES
            ),
            blocked_reason="the index format changed since this work was saved",
        )
    if checkpoint.state in {"completed", "failed"}:
        # A finished operation has nothing to continue. Reusing its checkpoint
        # would restart work that already reached a terminal outcome.
        return ResumePlan(
            decision="start_fresh",
            checkpoint=checkpoint,
            reusable=STAGES,
        )

    invalidated: list[Invalidation] = []
    for algorithm, recorded in checkpoint.algorithm_versions.items():
        current = algorithm_versions.get(algorithm)
        stage = STAGE_BY_ALGORITHM.get(algorithm)
        if stage is None or current is None or current == recorded:
            continue
        for downstream in STAGES[STAGES.index(stage) :]:
            invalidated.append(
                Invalidation(
                    downstream,
                    f"the {algorithm} algorithm changed from {recorded} to {current}",
                )
            )

    missing_roots = [
        root_id
        for root_id in checkpoint.high_water_marks
        if known_root_ids and root_id not in known_root_ids
    ]
    if missing_roots:
        invalidated.append(
            Invalidation(
                "discovery",
                f"{len(missing_roots)} root(s) from the saved work are no longer in the profile",
            )
        )

    invalidated_stages = {item.stage for item in invalidated}
    reusable = tuple(stage for stage in STAGES if stage not in invalidated_stages)
    return ResumePlan(
        decision="resume" if reusable else "restart",
        checkpoint=checkpoint,
        reusable=reusable,
        invalidated=_deduplicate(invalidated),
    )


def _deduplicate(items: Sequence[Invalidation]) -> tuple[Invalidation, ...]:
    """One reason per stage — the first, which names the actual cause."""
    seen: dict[Stage, Invalidation] = {}
    for item in items:
        seen.setdefault(item.stage, item)
    return tuple(seen[stage] for stage in STAGES if stage in seen)


@dataclass
class ResumeReport:
    """What the UI shows when an interrupted operation is picked up again."""

    plan: ResumePlan
    resumed_from_cursor: int = 0
    notes: list[str] = field(default_factory=list)

    @property
    def headline(self) -> str:
        if self.plan.decision == "start_fresh":
            return "Starting a new scan"
        if self.plan.decision == "restart":
            return "Starting over: the saved work no longer applies"
        if not self.plan.invalidated:
            return "Continuing where the last run stopped"
        return f"Continuing, redoing {len(self.plan.invalidated)} stage(s)"


def discover_resumable(
    catalog: MediaCatalog,
    operation_ids: Sequence[str],
    **compatibility: object,
) -> dict[str, ResumePlan]:
    """Plan a resume for each known operation, skipping the unreadable ones."""
    plans: dict[str, ResumePlan] = {}
    for operation_id in operation_ids:
        checkpoint = load_checkpoint(catalog, operation_id)
        plans[operation_id] = plan_resume(checkpoint, **compatibility)  # type: ignore[arg-type]
    return plans
