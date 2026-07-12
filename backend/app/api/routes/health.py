"""Health and system-info routes."""

import asyncio

from fastapi import APIRouter
from pydantic import BaseModel

from app._version import __version__
from app.api.deps import ContainerDep

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
