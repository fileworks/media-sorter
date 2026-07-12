"""Operation report routes.

Report payloads are intentionally returned as ``dict`` rather than mirror
Pydantic models: a report is a full historical record whose shape evolves with
the sort pipeline, and a strict ``response_model`` would silently drop any field
not yet mirrored. The typed query bounds below are the part worth enforcing.
"""

from typing import Any, Literal

from fastapi import APIRouter, Query
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from app.api.deps import ContainerDep

router = APIRouter()


class ExportRequest(BaseModel):
    format: Literal["csv", "json"] = "json"


@router.get("/reports")
async def list_reports(
    container: ContainerDep,
    # Bound the pagination params: SQLite reads ``LIMIT -1`` as "unbounded" and a
    # negative offset slips through, so cap them at the query layer.
    limit: int = Query(default=20, ge=1, le=500),
    offset: int = Query(default=0, ge=0),
) -> dict[str, Any]:
    """List all past sorting operations, newest first."""
    return await container.report_service.list_operations(limit=limit, offset=offset)


@router.get("/reports/{operation_id}")
async def get_report(operation_id: str, container: ContainerDep) -> dict[str, Any]:
    return await container.report_service.get_report(operation_id)


@router.delete("/reports")
async def clear_all_reports(container: ContainerDep) -> dict[str, Any]:
    """Delete all past sorting operations and their file records."""
    return await container.report_service.clear_all_history()


@router.post("/reports/{operation_id}/export")
async def export_report(
    operation_id: str,
    body: ExportRequest,
    container: ContainerDep,
) -> StreamingResponse:
    content, media_type, filename = await container.report_service.export(operation_id, body.format)
    return StreamingResponse(
        iter([content]),
        media_type=media_type,
        headers={
            "Content-Disposition": f'attachment; filename="{filename}"',
            "Access-Control-Expose-Headers": "Content-Disposition",
        },
    )
