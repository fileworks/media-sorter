"""Review-only burst detection and decision routes."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Response
from pydantic import BaseModel, Field

from app.api.deps import ConfigDep, ContainerDep
from app.core.paths import resolve_app_paths
from app.services.burst_detection import (
    BurstGroup,
    BurstQuarantinePlan,
    BurstSettings,
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


class BurstDetectionRequest(BaseModel):
    root: str = Field(min_length=1)
    paths: list[str] = Field(default_factory=list, max_length=100_000)


class BurstReviewRequest(BaseModel):
    group: BurstGroup
    keep_frame_ids: tuple[str, ...] = ()
    dismissed: bool = False


class BurstExecuteRequest(BaseModel):
    acknowledged: bool = False


class BurstExportRequest(BaseModel):
    format: Literal["json", "csv"] = "json"


@router.post("/review/bursts/detect", response_model=list[BurstGroup])
async def detect_bursts(
    body: BurstDetectionRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> list[BurstGroup]:
    settings = BurstSettings(
        enabled=config.burst_detection_enabled,
        time_window_seconds=config.burst_time_window_seconds,
        max_perceptual_distance=config.burst_perceptual_distance,
        require_camera_identity=config.burst_require_camera_identity,
    )
    groups = await asyncio.to_thread(
        container.burst_detection_service.detect,
        [Path(item) for item in body.paths],
        Path(body.root),
        settings,
    )
    return list(groups)


@router.post("/review/bursts/decision")
async def decide_burst(body: BurstReviewRequest) -> dict[str, object]:
    reviewed = review_burst(
        body.group,
        keep_frame_ids=body.keep_frame_ids,
        dismissed=body.dismissed,
    )
    quarantine = quarantine_candidates(reviewed)
    plan = plan_burst_quarantine(reviewed)
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
) -> dict[str, object]:
    plan = _PLANS.get(plan_id)
    if plan is None:
        raise HTTPException(status_code=404, detail="Burst plan not found or already executed")
    if not body.acknowledged:
        raise HTTPException(status_code=409, detail="Review and acknowledge the impact first")
    state_root = resolve_app_paths().data_dir
    operation_id = f"burst_{uuid.uuid4().hex[:16]}"
    try:
        records = await asyncio.to_thread(
            execute_burst_quarantine,
            plan,
            store_for_state_root(state_root),
            operation_id=operation_id,
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
