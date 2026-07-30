"""Health, system-info, and runtime-diagnostics routes."""

import asyncio
from typing import Any

from fastapi import APIRouter, Request
from pydantic import BaseModel

from app._version import __version__
from app.api.deps import ContainerDep
from app.core.logging_config import logging_health
from app.core.paths import resolve_app_paths
from app.core.rollout import active_gates
from app.core.rollout import describe as describe_gates
from app.services.support_bundle import export_bundle, preview_bundle

router = APIRouter()


class HealthResponse(BaseModel):
    status: str
    version: str


class HardwareResponse(BaseModel):
    logical_cpus: int
    total_ram_gb: float
    has_accelerator: bool
    recommended_tier: str
    onnx_providers: list[str]


@router.get("/health", response_model=HealthResponse)
async def health() -> HealthResponse:
    return HealthResponse(status="ok", version=__version__)


@router.get("/hardware", response_model=HardwareResponse)
async def hardware(container: ContainerDep) -> HardwareResponse:
    """Return the machine's AI-relevant hardware profile (probed once at startup)."""
    profile = await asyncio.to_thread(lambda: container.hardware_profile)
    return HardwareResponse(
        logical_cpus=profile.logical_cpus,
        total_ram_gb=profile.total_ram_gb,
        has_accelerator=profile.has_accelerator,
        recommended_tier=profile.recommended_tier,
        onnx_providers=profile.onnx_providers,
    )


class DiagnosticsResponse(BaseModel):
    """Where diagnostics go and what has degraded, without exposing content."""

    version: str
    logging: dict[str, Any]
    operations_needing_review: list[str]
    recovery_operations: list[dict[str, Any]]
    #: Which rollout gates this process is running with, and one line saying so.
    rollout_gates: dict[str, bool]
    rollout_summary: str
    thumbnail_cache: dict[str, Any]


@router.get("/diagnostics", response_model=DiagnosticsResponse)
async def diagnostics(request: Request, container: ContainerDep) -> DiagnosticsResponse:
    """Report log location, rotation, active sinks, drops, and pending recovery.

    Deliberately reports state rather than content: a caller learns that
    logging degraded or that an operation needs review, never what was logged.
    """
    health_snapshot = await asyncio.to_thread(logging_health)
    return DiagnosticsResponse(
        version=__version__,
        logging=health_snapshot,
        rollout_gates={str(key): value for key, value in active_gates().items()},
        rollout_summary=describe_gates(),
        operations_needing_review=list(
            getattr(request.app.state, "operations_needing_review", []) or []
        ),
        recovery_operations=list(getattr(request.app.state, "recovery_operations", []) or []),
        thumbnail_cache=await asyncio.to_thread(container.thumbnail_cache.diagnostics),
    )


class SupportBundleRequest(BaseModel):
    """An export is always an explicit, previewed choice."""

    operation_id: str | None = None
    include_paths: bool = False
    acknowledge_paths: bool = False


class SupportBundlePreviewResponse(BaseModel):
    categories: list[dict[str, Any]]
    excluded: list[str]
    include_paths: bool
    operation_id: str | None = None


class SupportBundleResponse(BaseModel):
    path: str
    include_paths: bool


@router.get("/diagnostics/bundle/preview", response_model=SupportBundlePreviewResponse)
async def preview_support_bundle(
    operation_id: str | None = None,
    include_paths: bool = False,
) -> SupportBundlePreviewResponse:
    """Show exactly what an export would contain, before creating anything."""
    paths = resolve_app_paths()
    preview = await asyncio.to_thread(
        preview_bundle,
        paths.data_dir,
        operation_id=operation_id,
        include_paths=include_paths,
    )
    return SupportBundlePreviewResponse(**preview.to_dict())


@router.post("/diagnostics/bundle", response_model=SupportBundleResponse)
async def create_support_bundle(
    request_body: SupportBundleRequest,
    container: ContainerDep,
) -> SupportBundleResponse:
    """Write a redacted diagnostics archive next to the application data.

    Including real paths needs a second, separate acknowledgement — the preview
    already said they would be tokenized, so overriding that must be deliberate.
    """
    include_paths = request_body.include_paths and request_body.acknowledge_paths
    paths = resolve_app_paths()
    destination = paths.data_dir / "diagnostics" / "mediasort-diagnostics.zip"
    written = await asyncio.to_thread(
        export_bundle,
        paths.data_dir,
        destination,
        config=container.config.to_dict(),
        operation_id=request_body.operation_id,
        include_paths=include_paths,
    )
    return SupportBundleResponse(path=str(written), include_paths=include_paths)
