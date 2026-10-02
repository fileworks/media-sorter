"""Directional existing-destination reconciliation routes."""

from __future__ import annotations

import asyncio
from typing import Annotated

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

from app.api.deps import ConfigDep, ContainerDep
from app.core.config_fingerprint import config_fingerprint
from app.core.integrity import MutationManifest
from app.core.library_validation import validate_configured_library
from app.core.paths import resolve_app_paths
from app.services.catalog_views import CursorError
from app.services.destination_reconciliation import (
    FindingClass,
    ReconciliationPage,
    ReconciliationReport,
)
from app.services.manifest_execution import execute_manifest

router = APIRouter()
_PLANS: dict[str, MutationManifest] = {}


class CompareRequest(BaseModel):
    input_available: bool = True


class ReconciliationPlanRequest(BaseModel):
    report_id: str | None = None
    report: ReconciliationReport | None = None
    finding_ids: tuple[str, ...]
    confirm_probable: tuple[str, ...] = ()


class ReconciliationExecuteRequest(BaseModel):
    acknowledged: bool = False


@router.post("/reconciliation/compare", response_model=ReconciliationPage)
async def compare_destination(
    body: CompareRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> ReconciliationPage:
    library = await asyncio.to_thread(validate_configured_library, config)
    if library.destination is None:
        raise ValueError("destination is required")
    return await asyncio.to_thread(
        container.destination_reconciliation_service.compare_paged,
        library.inputs[0].canonical_path,
        library.destination.canonical_path,
        config,
        input_available=body.input_available,
    )


@router.get(
    "/reconciliation/reports/{report_id}/findings",
    response_model=ReconciliationPage,
)
async def reconciliation_findings(
    report_id: str,
    container: ContainerDep,
    cursor: Annotated[str | None, Query()] = None,
    classification: Annotated[FindingClass | None, Query()] = None,
    limit: Annotated[int, Query(ge=1, le=500)] = 100,
) -> ReconciliationPage:
    try:
        return await asyncio.to_thread(
            container.destination_reconciliation_service.page,
            report_id,
            cursor=cursor,
            classification=classification,
            page_size=limit,
        )
    except KeyError as exc:
        raise HTTPException(status_code=404, detail="Reconciliation report not found") from exc
    except CursorError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc


@router.post("/reconciliation/plan")
async def plan_reconciliation(
    body: ReconciliationPlanRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> dict[str, object]:
    try:
        if body.report_id is not None:
            manifest = await asyncio.to_thread(
                container.destination_reconciliation_service.plan_saved,
                body.report_id,
                body.finding_ids,
                config=config,
                confirm_probable=body.confirm_probable,
            )
        elif body.report is not None:
            manifest = await asyncio.to_thread(
                container.destination_reconciliation_service.plan,
                body.report,
                body.finding_ids,
                config=config,
                confirm_probable=body.confirm_probable,
            )
        else:
            raise ValueError("a reconciliation report is required")
    except ValueError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    _PLANS[manifest.manifest_id] = manifest
    return {
        "plan_id": manifest.manifest_id,
        "manifest": manifest.model_dump(mode="json"),
        "action_count": len(manifest.actions),
        "bytes_affected": sum(action.expected_size_bytes for action in manifest.actions),
        "source_mutations": sum(action.effects.source != "retained" for action in manifest.actions),
    }


@router.post("/reconciliation/plans/{plan_id}/execute")
async def execute_reconciliation(
    plan_id: str,
    body: ReconciliationExecuteRequest,
    config: ConfigDep,
) -> dict[str, object]:
    manifest = _PLANS.get(plan_id)
    if manifest is None:
        raise HTTPException(status_code=404, detail="Reconciliation plan not found")
    if not body.acknowledged:
        raise HTTPException(status_code=409, detail="Review and acknowledge the impact first")
    if manifest.effective_config_sha256 != config_fingerprint(config):
        raise HTTPException(
            status_code=409,
            detail="Configuration changed after planning; reconcile again",
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
            }
            for result in results
        ],
    }
