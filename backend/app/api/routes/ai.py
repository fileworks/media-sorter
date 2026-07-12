"""AI utility routes — category name suggestion."""

import asyncio

from fastapi import APIRouter
from pydantic import BaseModel, Field

from app.api.deps import ContainerDep
from app.core.exceptions import MediaSortException

router = APIRouter()


class SuggestCategoriesRequest(BaseModel):
    n_categories: int = Field(default=5, ge=2, le=12)


class SuggestCategoriesResponse(BaseModel):
    suggestions: list[str]


@router.post("/ai/suggest-categories", response_model=SuggestCategoriesResponse)
async def suggest_categories(
    body: SuggestCategoriesRequest,
    container: ContainerDep,
) -> SuggestCategoriesResponse:
    """Suggest category names by clustering a sample of images from the source dir.

    Returns 503 when no encoder is available (tier=off or fastembed not installed).
    The clustering runs in a worker thread so the event loop stays unblocked.
    """
    if container.encoder is None:
        raise MediaSortException(
            status_code=503,
            message="No AI encoder available — enable a local AI tier to use suggestions",
            code="ENCODER_UNAVAILABLE",
        )

    suggestions = await asyncio.to_thread(
        container.category_suggestion_service.suggest,
        body.n_categories,
    )
    return SuggestCategoriesResponse(suggestions=suggestions)
