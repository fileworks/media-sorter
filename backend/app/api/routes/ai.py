"""AI utility routes — category name suggestion."""

import asyncio
from typing import Any

from fastapi import APIRouter, Query
from pydantic import BaseModel, Field

from app.api.deps import ConfigDep, ContainerDep
from app.api.schemas import (
    TaskCancelResponse,
    TaskProgressResponse,
    TaskStartRequest,
    TaskStartResponse,
)
from app.background_tasks.task_manager import Task, TaskManager
from app.core.exceptions import ConflictError, MediaSortException, TaskNotFoundError
from app.services.ai.model_installation import AiModelStore
from app.services.ai.model_manifest import pack_for_tier

router = APIRouter()


class SuggestCategoriesRequest(BaseModel):
    n_categories: int = Field(default=5, ge=2, le=12)


class SuggestCategoriesResponse(BaseModel):
    suggestions: list[str]


class ModelStatusResponse(BaseModel):
    pack_id: str
    model_id: str
    display_name: str
    state: str
    total_size: int
    installed_size: int
    license: str
    license_url: str
    source: str
    task_id: str | None = None
    error: str | None = None


class ModelInventoryResponse(BaseModel):
    effective_tier: str
    required_pack_id: str | None
    packs: list[ModelStatusResponse]


class RemoveModelRequest(BaseModel):
    acknowledge_removal: bool = False


def _pack_task(container: Any, pack_id: str) -> Task | None:
    manager: TaskManager = container.model_task_manager
    for task in reversed(manager.tasks()):
        for event in task.events:
            if event.name == "model.pack" and event.fields.get("pack_id") == pack_id:
                return task
    return None


@router.get("/ai/models", response_model=ModelInventoryResponse)
async def model_inventory(
    container: ContainerDep,
    config: ConfigDep,
) -> ModelInventoryResponse:
    tier = container.hardware_profile.effective_tier(config.ai_model_tier)
    required = pack_for_tier(tier)
    statuses = [
        container.ai_model_store.status(pack_id, task=_pack_task(container, pack_id))
        for pack_id in container.ai_model_store.packs
    ]
    return ModelInventoryResponse(
        effective_tier=tier,
        required_pack_id=required,
        packs=[ModelStatusResponse.model_validate(status.to_dict()) for status in statuses],
    )


async def _install_model(task: Task, container: Any, pack_id: str) -> dict[str, object]:
    task.add_event("model.pack", pack_id=pack_id)
    store: AiModelStore = container.ai_model_store
    result = await store.install(task, pack_id)
    container.reset_encoder()
    return result


@router.post("/ai/models/{pack_id}/install", response_model=TaskStartResponse)
async def install_model(
    pack_id: str,
    container: ContainerDep,
    body: TaskStartRequest | None = None,
) -> TaskStartResponse:
    request = body or TaskStartRequest()
    existing = _pack_task(container, pack_id)
    if existing is not None and existing.status in ("pending", "running"):
        return TaskStartResponse(
            task_id=existing.id,
            operation_kind=existing.operation_kind,
            status=existing.status,
            replayed=True,
        )
    task, replayed = container.model_task_manager.start_task(
        "model_download",
        f"{pack_id}:{request.idempotency_key}",
        _install_model,
        container,
        pack_id,
    )
    return TaskStartResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        replayed=replayed,
    )


@router.get("/ai/models/tasks/{task_id}", response_model=TaskProgressResponse)
async def model_task_status(
    task_id: str,
    container: ContainerDep,
    after_sequence: int = Query(default=0, ge=0),
) -> TaskProgressResponse:
    task = container.model_task_manager.get_task(task_id)
    if task is None:
        raise TaskNotFoundError(task_id)
    return TaskProgressResponse.from_task(task, after_sequence=after_sequence)


@router.post("/ai/models/tasks/{task_id}/cancel", response_model=TaskCancelResponse)
async def cancel_model_install(
    task_id: str,
    container: ContainerDep,
) -> TaskCancelResponse:
    task = container.model_task_manager.get_task(task_id)
    if task is None:
        raise TaskNotFoundError(task_id)
    requested = container.model_task_manager.cancel_task(task_id)
    return TaskCancelResponse(
        task_id=task.id,
        operation_kind=task.operation_kind,
        status=task.status,
        cancellation_requested=requested,
    )


@router.delete("/ai/models/{pack_id}", response_model=ModelStatusResponse)
async def remove_model(
    pack_id: str,
    body: RemoveModelRequest,
    container: ContainerDep,
) -> ModelStatusResponse:
    active = _pack_task(container, pack_id)
    if active is not None and active.status in ("pending", "running"):
        raise ConflictError("The model is still downloading; cancel it before removal.")
    media_task = container.task_manager.active_task()
    if media_task is not None:
        raise ConflictError(
            "Wait for the active media operation to finish before removing its model files.",
            details={
                "active_task_id": media_task.id,
                "active_operation_kind": media_task.operation_kind,
            },
        )
    if not body.acknowledge_removal:
        raise MediaSortException(
            status_code=400,
            message="Model removal requires explicit confirmation.",
            code="MODEL_REMOVAL_CONFIRMATION_REQUIRED",
        )
    container.reset_encoder()
    await asyncio.to_thread(container.ai_model_store.remove, pack_id)
    return ModelStatusResponse.model_validate(container.ai_model_store.status(pack_id).to_dict())


@router.post("/ai/suggest-categories", response_model=SuggestCategoriesResponse)
async def suggest_categories(
    body: SuggestCategoriesRequest,
    container: ContainerDep,
    config: ConfigDep,
) -> SuggestCategoriesResponse:
    """Suggest category names by clustering a sample of images from the source dir.

    Returns 409 with install details when the selected optional pack is absent,
    or 503 when local AI is disabled/unavailable for another reason. Clustering
    runs in a worker thread so the event loop stays unblocked.
    """
    if container.encoder is None:
        tier = container.hardware_profile.effective_tier(config.ai_model_tier)
        pack_id = pack_for_tier(tier)
        if pack_id is not None:
            status = container.ai_model_store.status(pack_id)
            if status.state != "ready":
                raise MediaSortException(
                    status_code=409,
                    message="Install the selected local AI model before using suggestions.",
                    code="MODEL_NOT_INSTALLED",
                    details=status.to_dict(),
                )
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
