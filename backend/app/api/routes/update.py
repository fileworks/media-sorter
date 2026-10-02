"""Update check route — GET /api/update."""

from fastapi import APIRouter
from pydantic import BaseModel

from app.api.deps import ContainerDep

router = APIRouter()


class UpdateResponse(BaseModel):
    current_version: str
    latest_version: str | None
    update_available: bool
    release_url: str | None
    release_notes: str | None
    published_at: str | None
    checked_at: str
    asset_url: str | None = None


@router.get("/update", response_model=UpdateResponse)
async def get_update(container: ContainerDep, force: bool = False) -> UpdateResponse:
    """Return the latest available version from GitHub Releases.

    Best-effort: on any network/parse failure the response has
    ``update_available=False`` and the app continues normally.
    """
    info = await container.update_service.check(force=force)
    return UpdateResponse(
        current_version=info.current_version,
        latest_version=info.latest_version,
        update_available=info.update_available,
        release_url=info.release_url,
        release_notes=info.release_notes,
        published_at=info.published_at,
        checked_at=info.checked_at,
        asset_url=info.asset_url,
    )
