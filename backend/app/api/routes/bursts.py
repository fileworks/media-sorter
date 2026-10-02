"""Review-only burst detection and decision routes."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, ConfigDict

from app.api.deps import ContainerDep
from app.core.library_validation import validate_configured_library
from app.core.paths import resolve_app_paths
from app.services.burst_detection import (
    BurstQuarantinePlan,
    build_burst_report,
    execute_burst_quarantine,
    export_burst_report,
    load_burst_report,
    plan_burst_quarantine,
    quarantine_candidates,
    review_burst,
    save_burst_report,
)
from app.services.quarantine import QuarantineError, store_for_state_root

router = APIRouter()
_PLANS: dict[str, BurstQuarantinePlan] = {}


def _authority_roots(
    container: ContainerDep,
) -> tuple[tuple[Path, ...], tuple[Path, ...], tuple[Path, ...], tuple[str, ...]]:
    library = validate_configured_library(container.config)
    return (
        tuple(root.canonical_path for root in library.inputs),
        tuple(root.canonical_path for root in library.references),
        tuple(exclusion for root in library.inputs for exclusion in root.exclusions),
        tuple(container.config.exclude_patterns),
    )


class BurstReviewRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    group_id: str
    keep_frame_ids: tuple[str, ...] = ()
    dismissed: bool = False


class BurstExecuteRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    acknowledged: bool = False


class BurstExportRequest(BaseModel):
    model_config = ConfigDict(extra="forbid")

    format: Literal["json", "csv"] = "json"


@router.post("/review/bursts/decision")
async def decide_burst(container: ContainerDep, body: BurstReviewRequest) -> dict[str, object]:
    group = container.burst_detection_service.issued_group(body.group_id)
    if group is None:
        raise HTTPException(status_code=409, detail="Burst group was not issued by this server")
    allowed, protected, excluded, patterns = _authority_roots(container)
    reviewed = review_burst(
        group,
        keep_frame_ids=body.keep_frame_ids,
        dismissed=body.dismissed,
    )
    quarantine = quarantine_candidates(reviewed)
    try:
        plan = plan_burst_quarantine(
            reviewed,
            allowed_roots=allowed,
            protected_roots=protected,
            excluded_roots=excluded,
            exclude_patterns=patterns,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    if plan.members:
        _PLANS[plan.plan_id] = plan
    return {
        "group": reviewed.model_dump(mode="json"),
        "plan": plan.model_dump(mode="json"),
        "impact": {
            "quarantine_count": len(plan.members),
            "quarantine_bytes": plan.bytes_affected,
            "source_mutations": len(plan.members),
            "irreversible": (
                "No files are deleted. Selected media-unit members move to managed quarantine."
            ),
        },
        "planned_quarantine_units": [
            {
                "unit_id": frame.unit_id,
                "members": list(frame.member_paths),
                "action": "quarantine",
                "delete": False,
            }
            for frame in quarantine
        ],
    }


@router.post("/review/bursts/plans/{plan_id}/execute")
async def execute_burst_plan(
    plan_id: str,
    body: BurstExecuteRequest,
    container: ContainerDep,
) -> dict[str, object]:
    plan = _PLANS.get(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Burst plan not found or already executed")
    if not body.acknowledged:
        raise HTTPException(status_code=409, detail="Review and acknowledge the impact first")
    state_root = resolve_app_paths().data_dir
    allowed, protected, excluded, patterns = _authority_roots(container)
    operation_id = f"burst_{uuid.uuid4().hex[:16]}"
    try:
        records = await asyncio.to_thread(
            execute_burst_quarantine,
            plan,
            store_for_state_root(state_root),
            operation_id=operation_id,
            allowed_roots=allowed,
            protected_roots=protected,
            excluded_roots=excluded,
            exclude_patterns=patterns,
        )
        report = build_burst_report(plan, records, operation_id=operation_id)
        await asyncio.to_thread(save_burst_report, report, state_root)
    except (OSError, QuarantineError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _PLANS.pop(plan_id, None)
    return report.model_dump(mode="json")


@router.get("/review/bursts/reports/{operation_id}")
async def get_burst_report(operation_id: str) -> dict[str, object]:
    report = await asyncio.to_thread(
        load_burst_report,
        operation_id,
        resolve_app_paths().data_dir,
    )
    if report is None:
        raise HTTPException(status_code=404, detail="Burst report not found")
    return report.model_dump(mode="json")


@router.post("/review/bursts/reports/{operation_id}/export")
async def export_burst_run(
    operation_id: str,
    body: BurstExportRequest,
) -> Response:
    report = await asyncio.to_thread(
        load_burst_report,
        operation_id,
        resolve_app_paths().data_dir,
    )
    if report is None:
        raise HTTPException(status_code=404, detail="Burst report not found")
    content = export_burst_report(report, body.format)
    media_type = "application/json" if body.format == "json" else "text/csv"
    return Response(content=content, media_type=media_type)
