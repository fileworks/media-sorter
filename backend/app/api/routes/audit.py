"""Read-only standalone library-audit routes."""

from __future__ import annotations

import asyncio
import uuid
from pathlib import Path
from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel, Field

from app.api.deps import ConfigDep, ContainerDep
from app.api.routes.scan import _cancel_task, _task_status
from app.api.schemas import TaskCancelResponse, TaskProgressResponse, TaskStartResponse
from app.background_tasks.task_manager import Task
from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.integrity import MutationManifest
from app.core.paths import resolve_app_paths
from app.services.library_audit import AuditReport, AuditScope, LibraryAuditService
from app.services.manifest_execution import execute_manifest

router = APIRouter()
_PLANS: dict[str, MutationManifest] = {}


class AuditRequest(BaseModel):
    root: str = Field(min_length=1)
    scope: AuditScope = AuditScope()
    idempotency_key: str | None = None


class AuditExportRequest(BaseModel):
    format: Literal["json", "csv"] = "json"


class AuditPlanRequest(BaseModel):
    finding_ids: tuple[str, ...] = Field(min_length=1)


class AuditExecuteRequest(BaseModel):
    acknowledged: bool = False


async def _run_audit(
    task: Task,
    service: LibraryAuditService,
    request: AuditRequest,
    config: Config,
) -> dict[str, object]:
    task.transition("auditing")

    def progress(current: int) -> None:
        task.update_progress(current)

    report = await asyncio.to_thread(
        service.run,
        root=Path(request.root),
        scope=request.scope,
        config=config,
        cancel=task.cancel_token.is_set,
        progress=progress,
    )
    task.partial = report.coverage == "partial"
    task.issues = [{"message": issue} for issue in report.issues]
    return report.model_dump(mode="json")


@router.post("/audit", response_model=AuditReport)
async def audit_now(
    body: AuditRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> AuditReport:
    return await asyncio.to_thread(
        container.library_audit_service.run,
        Path(body.root),
        scope=body.scope,
        config=config,
    )


@router.post("/audit/start", response_model=TaskStartResponse)
async def start_audit(
    body: AuditRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> TaskStartResponse:
    task, replayed = container.task_manager.start_task(
        "audit",
        body.idempotency_key or f"audit-{uuid.uuid4()}",
        _run_audit,
        container.library_audit_service,
        body,
        Config.from_dict(config.to_dict()),
    )
    return TaskStartResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        replayed=replayed,
    )


@router.get("/audit/tasks/{task_id}", response_model=TaskProgressResponse)
async def audit_progress(
    task_id: str,
    container: ContainerDep,
    after_sequence: int = Query(default=0, ge=0),
) -> TaskProgressResponse:
    return _task_status(task_id, container, after_sequence, None, None)


@router.post("/audit/tasks/{task_id}/cancel", response_model=TaskCancelResponse)
async def cancel_audit(task_id: str, container: ContainerDep) -> TaskCancelResponse:
    return _cancel_task(task_id, container, None, None)


@router.get("/audit/history", response_model=list[AuditReport])
async def audit_history(
    container: ContainerDep,
    limit: int = Query(default=24, ge=1, le=24),
) -> list[AuditReport]:
    return list(await asyncio.to_thread(container.library_audit_service.history, limit))


@router.get("/audit/reports/{audit_id}", response_model=AuditReport)
async def audit_report(audit_id: str, container: ContainerDep) -> AuditReport:
    report = await asyncio.to_thread(container.library_audit_service.get, audit_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Audit report not found")
    return report


@router.post("/audit/reports/{audit_id}/export")
async def export_audit(
    audit_id: str,
    body: AuditExportRequest,
    container: ContainerDep,
) -> Response:
    service = container.library_audit_service
    report = await asyncio.to_thread(service.get, audit_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Audit report not found")
    content = await asyncio.to_thread(service.export, report, body.format)
    media_type = "application/json" if body.format == "json" else "text/csv"
    return Response(content=content, media_type=media_type)


@router.post("/audit/reports/{audit_id}/plan")
async def plan_audit_fixes(
    audit_id: str,
    body: AuditPlanRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> dict[str, object]:
    report = await asyncio.to_thread(container.library_audit_service.get, audit_id)
    if report is None:
        raise HTTPException(status_code=404, detail="Audit report not found")
    try:
        manifest = await asyncio.to_thread(
            container.library_audit_service.plan,
            report,
            body.finding_ids,
            config=config,
        )
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _PLANS[manifest.manifest_id] = manifest
    return {
        "plan_id": manifest.manifest_id,
        "action_count": len(manifest.actions),
        "bytes_affected": sum(action.expected_size_bytes for action in manifest.actions),
        "source_mutations": len(manifest.actions),
        "config_fingerprint": manifest.effective_config_sha256,
    }


@router.post("/audit/plans/{plan_id}/execute")
async def execute_audit_fixes(
    plan_id: str,
    body: AuditExecuteRequest,
    config: ConfigDep,
) -> dict[str, object]:
    manifest = _PLANS.get(plan_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Audit plan not found or already executed")
    if not body.acknowledged:
        raise HTTPException(status_code=409, detail="Review and acknowledge the impact first")
    if manifest.effective_config_sha256 != config_fingerprint(config):
        raise HTTPException(
            status_code=409,
            detail="Configuration changed after planning; run the audit plan again",
        )
    try:
        results = await asyncio.to_thread(
            execute_manifest,
            manifest,
            state_root=resolve_app_paths().data_dir,
        )
    except (OSError, ValueError) as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _PLANS.pop(plan_id, None)
    return {
        "plan_id": plan_id,
        "completed": len(results),
        "results": [
            {
                "source_path": str(result.source_path),
                "destination_path": str(result.destination_path),
                "source_safety": result.source_safety,
                "commit_method": result.commit_method,
            }
            for result in results
        ],
    }
