"""Optimization contract, projection, and quarantine routes.

Everything here is read-only or preview-only. Nothing on this router mutates a
single original: projections encode into a preview workspace under the app data
directory, and the quarantine endpoints report state. Execution goes through the
sorting pipeline, where authorization and journalling live.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel, Field

from app.api.deps import ContainerDep
from app.core.library_profiles import CatalogPlacement
from app.core.optimization_contracts import (
    CONTRACTS,
    OptimizationUnavailableError,
    discover_tool,
)
from app.core.paths import resolve_app_paths
from app.services.catalog_location import (
    budget,
    catalog_path,
    freshness,
    open_catalog,
    reset_catalog,
)
from app.services.optimization_preview import (
    ItemProjection,
    OptimizationProjection,
    PreviewItem,
    SampleEncode,
    project_optimization,
)
from app.services.quarantine import store_for_state_root

router = APIRouter()

PREVIEW_WORKSPACE_NAME = "optimization-preview"


class MetricModel(BaseModel):
    name: str
    comparison: str
    threshold: float | int | str | bool
    applies_to: str
    rationale: str


class ContractModel(BaseModel):
    """Everything a user must be able to read *before* selecting a profile."""

    contract_id: str
    media_kind: str
    mode: str
    status: str
    enabled: bool
    source_formats: list[str]
    output_container: str
    output_codec: str
    tool: str
    tool_available: bool
    tool_version: str | None
    minimum_tool_version: str
    decoded_content: str
    metadata_policy: str
    quality_setting: str
    metrics: list[MetricModel]
    compatibility_warnings: list[str]


class SampleModel(BaseModel):
    source_path: str
    candidate_path: str | None
    source_bytes: int
    candidate_bytes: int
    size_reduction_ratio: float
    sampling_scope: str
    passed: bool | None
    measurements: dict[str, Any]
    thresholds: dict[str, Any]
    warnings: list[str]
    comparable: bool


class ItemProjectionModel(BaseModel):
    path: str
    current_bytes: int
    projected_low_bytes: int | None
    projected_high_bytes: int | None
    estimated_saving_bytes: int | None
    confidence: str
    estimate_only: bool
    output_container: str
    output_codec: str
    quality_setting: str
    validation_method: str
    compatibility_warnings: list[str]
    temporary_space_bytes: int
    quarantine_space_bytes: int
    recommendation: str
    reason: str
    sample_source_path: str | None


class ProjectionModel(BaseModel):
    contract_id: str
    mode: str
    output_container: str
    output_codec: str
    item_count: int
    current_bytes: int
    projected_low_bytes: int | None
    projected_high_bytes: int | None
    estimated_saving_bytes: int | None
    confidence: str
    estimate_only: bool
    recommended_count: int
    skipped_count: int
    blocked_count: int
    temporary_space_bytes: int
    quarantine_space_bytes: int
    samples: list[SampleModel]
    items: list[ItemProjectionModel]
    warnings: list[str]
    compatibility_warnings: list[str]
    failures: list[str]


class PreviewRequest(BaseModel):
    contract_id: str = Field(min_length=1)
    paths: list[str] = Field(min_length=1, max_length=5000)
    #: Retaining candidates is what makes the comparison modal possible; without
    #: it the preview is numbers only, and says so.
    retain_samples: bool = True
    max_samples: int = Field(default=3, ge=1, le=10)


class QuarantineRecordModel(BaseModel):
    record_id: str
    operation_id: str
    reason: str
    original_path: str
    quarantine_path: str
    keeper_path: str | None
    size_bytes: int
    quarantined_at: str
    retention: str
    restored_to: str | None
    age_days: float
    notes: list[str]


@router.get("/optimization/contracts", response_model=list[ContractModel])
async def list_contracts() -> list[ContractModel]:
    """Every declared contract, its status, and whether its tool exists here."""
    return await asyncio.to_thread(_contract_models)


def _contract_models() -> list[ContractModel]:
    models: list[ContractModel] = []
    for contract in CONTRACTS.values():
        capability = discover_tool(contract.tool)
        models.append(
            ContractModel(
                contract_id=contract.contract_id,
                media_kind=contract.media_kind,
                mode=contract.mode,
                status=contract.status,
                enabled=contract.enabled,
                source_formats=list(contract.source_formats),
                output_container=contract.output_container,
                output_codec=contract.output_codec,
                tool=contract.tool,
                tool_available=capability.available,
                tool_version=capability.version,
                minimum_tool_version=contract.minimum_tool_version,
                decoded_content=contract.decoded_content,
                metadata_policy=contract.metadata_policy,
                quality_setting=", ".join(
                    f"{key}={value}" for key, value in sorted(contract.parameters.items())
                )
                or "container defaults",
                metrics=[
                    MetricModel(
                        name=metric.name,
                        comparison=metric.comparison,
                        threshold=metric.threshold,
                        applies_to=metric.applies_to,
                        rationale=metric.rationale,
                    )
                    for metric in contract.metrics
                ],
                compatibility_warnings=list(contract.compatibility_warnings),
            )
        )
    return models


@router.post("/optimization/preview", response_model=ProjectionModel)
async def preview_optimization(body: PreviewRequest) -> ProjectionModel:
    """Encode a bounded sample and project the whole selection from it."""
    items = await asyncio.to_thread(_readable_items, body.paths)
    if not items:
        raise HTTPException(status_code=400, detail="None of the given paths could be read")
    workspace = (
        resolve_app_paths().data_dir / PREVIEW_WORKSPACE_NAME if body.retain_samples else None
    )
    try:
        projection = await asyncio.to_thread(
            project_optimization,
            items,
            body.contract_id,
            workspace=workspace,
            max_samples=body.max_samples,
        )
    except OptimizationUnavailableError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return _projection_model(projection)


def _readable_items(paths: list[str]) -> list[PreviewItem]:
    items: list[PreviewItem] = []
    for raw in paths:
        candidate = Path(raw)
        try:
            if candidate.is_file():
                items.append(PreviewItem(candidate, candidate.stat().st_size))
        except OSError:
            continue
    return items


def _projection_model(projection: OptimizationProjection) -> ProjectionModel:
    return ProjectionModel(
        contract_id=projection.contract_id,
        mode=projection.mode,
        output_container=projection.output_container,
        output_codec=projection.output_codec,
        item_count=projection.item_count,
        current_bytes=projection.current_bytes,
        projected_low_bytes=projection.projected_low_bytes,
        projected_high_bytes=projection.projected_high_bytes,
        estimated_saving_bytes=projection.estimated_saving_bytes,
        confidence=projection.confidence,
        estimate_only=projection.estimate_only,
        recommended_count=projection.recommended_count,
        skipped_count=projection.skipped_count,
        blocked_count=projection.blocked_count,
        temporary_space_bytes=projection.temporary_space_bytes,
        quarantine_space_bytes=projection.quarantine_space_bytes,
        samples=[_sample_model(sample) for sample in projection.samples],
        items=[_item_model(item) for item in projection.items],
        warnings=list(projection.warnings),
        compatibility_warnings=list(projection.compatibility_warnings),
        failures=list(projection.failures),
    )


def _sample_model(sample: SampleEncode) -> SampleModel:
    return SampleModel(
        source_path=str(sample.source_path),
        candidate_path=None if sample.candidate_path is None else str(sample.candidate_path),
        source_bytes=sample.source_bytes,
        candidate_bytes=sample.candidate_bytes,
        size_reduction_ratio=sample.size_reduction_ratio,
        sampling_scope=sample.sampling_scope,
        passed=sample.quality.passed,
        measurements=dict(sample.quality.measurements),
        thresholds=dict(sample.quality.thresholds),
        warnings=list(sample.quality.warnings),
        comparable=sample.comparable,
    )


def _item_model(item: ItemProjection) -> ItemProjectionModel:
    return ItemProjectionModel(
        path=str(item.path),
        current_bytes=item.current_bytes,
        projected_low_bytes=item.projected_low_bytes,
        projected_high_bytes=item.projected_high_bytes,
        estimated_saving_bytes=item.estimated_saving_bytes,
        confidence=item.confidence,
        estimate_only=item.estimate_only,
        output_container=item.output_container,
        output_codec=item.output_codec,
        quality_setting=item.quality_setting,
        validation_method=item.validation_method,
        compatibility_warnings=list(item.compatibility_warnings),
        temporary_space_bytes=item.temporary_space_bytes,
        quarantine_space_bytes=item.quarantine_space_bytes,
        recommendation=item.recommendation,
        reason=item.reason,
        sample_source_path=None
        if item.sample_source_path is None
        else str(item.sample_source_path),
    )


@router.get("/quarantine", response_model=list[QuarantineRecordModel])
async def list_quarantine(
    retention: str | None = Query(default=None, pattern="^(retained|restored|removed)$"),
) -> list[QuarantineRecordModel]:
    """Every quarantined original, newest state first."""
    store = store_for_state_root(resolve_app_paths().data_dir)
    records = await asyncio.to_thread(store.records)
    return [
        QuarantineRecordModel(
            record_id=record.record_id,
            operation_id=record.operation_id,
            reason=record.reason,
            original_path=record.original_path,
            quarantine_path=record.quarantine_path,
            keeper_path=record.keeper_path,
            size_bytes=record.size_bytes,
            quarantined_at=record.quarantined_at,
            retention=record.retention,
            restored_to=record.restored_to,
            age_days=record.age_days,
            notes=list(record.notes),
        )
        for record in records
        if retention is None or record.retention == retention
    ]


@router.get("/quarantine/summary")
async def quarantine_summary() -> dict[str, Any]:
    """Counts, bytes, and ages — never a path."""
    store = store_for_state_root(resolve_app_paths().data_dir)
    return await asyncio.to_thread(store.summary)


class RestoreRequest(BaseModel):
    record_id: str
    target_path: str | None = None
    on_conflict: str = Field(default="block", pattern="^(block|alternate_path|skip)$")


@router.post("/quarantine/restore/preview")
async def preview_restore(body: RestoreRequest) -> dict[str, Any]:
    """Describe a restore fully before any byte moves."""
    store = store_for_state_root(resolve_app_paths().data_dir)
    record = await asyncio.to_thread(store.find, body.record_id)
    if record is None:
        raise HTTPException(status_code=404, detail="No such quarantine record")
    target = Path(body.target_path) if body.target_path else None
    preview = await asyncio.to_thread(store.preview_restore, record, target=target)
    return {
        "record_id": record.record_id,
        "target_path": str(preview.target_path),
        "restorable": preview.restorable,
        "conflict": preview.conflict,
        "conflict_is_identical": preview.conflict_is_identical,
        "quarantined_file_present": preview.quarantined_file_present,
        "hash_matches": preview.hash_matches,
        "blocked_reason": preview.blocked_reason,
    }


# --------------------------------------------------------------------------- #
# Catalog diagnostics and maintenance                                          #
# --------------------------------------------------------------------------- #


class CatalogDiagnosticsResponse(BaseModel):
    """Where the index is, what it costs, and how fresh each root is."""

    path: str
    schema_version: int
    size_bytes: int
    soft_limit_bytes: int
    over_soft_limit: bool
    mode: str
    roots: int
    files: int
    hashed_files: int
    missing_files: int
    generations: int
    open_generations: int
    freshness: list[dict[str, Any]]


@router.get("/catalog/diagnostics", response_model=CatalogDiagnosticsResponse)
async def catalog_diagnostics(container: ContainerDep) -> CatalogDiagnosticsResponse:
    """Report the catalog's location, size, budget, and per-root freshness."""
    return await asyncio.to_thread(_catalog_diagnostics, container)


def _catalog_diagnostics(container: Any) -> CatalogDiagnosticsResponse:
    placement = _placement_for(container)
    data_dir = resolve_app_paths().data_dir
    path = catalog_path(placement, data_dir=data_dir)
    with open_catalog(placement, data_dir=data_dir) as catalog:
        diagnostics = catalog.diagnostics()
        limits = budget(diagnostics)
        roots = [
            freshness(catalog, root_id).model_dump(mode="json") for root_id in _root_ids(container)
        ]
    return CatalogDiagnosticsResponse(
        path=str(path),
        schema_version=diagnostics.schema_version,
        size_bytes=diagnostics.size_bytes,
        soft_limit_bytes=limits.soft_limit_bytes,
        over_soft_limit=limits.over_soft_limit,
        mode=placement.mode,
        roots=diagnostics.roots,
        files=diagnostics.files,
        hashed_files=diagnostics.hashed_files,
        missing_files=diagnostics.missing_files,
        generations=diagnostics.generations,
        open_generations=diagnostics.open_generations,
        freshness=roots,
    )


def _placement_for(container: Any) -> CatalogPlacement:
    profile = getattr(container.config, "library_profile", None)
    placement = getattr(profile, "catalog", None)
    # Portable placement needs the directory a profile was exported to; the
    # running app always resolves against its own data directory instead.
    if not isinstance(placement, CatalogPlacement) or placement.mode != "application_data":
        return CatalogPlacement()
    return placement


def _root_ids(container: Any) -> list[str]:
    profile = getattr(container.config, "library_profile", None)
    roots = getattr(profile, "roots", None) or []
    return [root.root_id for root in roots if getattr(root, "root_id", None)]


class CatalogRebuildRequest(BaseModel):
    """Rebuilding is per root; resetting the whole index needs a confirmation."""

    root_id: str | None = None
    confirm_full_reset: bool = False


@router.post("/catalog/rebuild")
async def rebuild_catalog(
    body: CatalogRebuildRequest,
    container: ContainerDep,
) -> dict[str, Any]:
    """Forget indexed facts so they are recomputed. Media is never touched.

    A single root is dropped from the index; a full reset deletes the file and
    requires an explicit confirmation, because it throws away every hash the
    machine has ever computed.
    """
    placement = _placement_for(container)
    data_dir = resolve_app_paths().data_dir
    path = catalog_path(placement, data_dir=data_dir)

    if body.root_id:

        def _forget() -> None:
            with open_catalog(placement, data_dir=data_dir) as catalog:
                catalog.forget_root(body.root_id or "")

        await asyncio.to_thread(_forget)
        return {"reset": False, "root_id": body.root_id, "path": str(path)}

    if not body.confirm_full_reset:
        raise HTTPException(
            status_code=400,
            detail="A full catalog reset requires confirm_full_reset",
        )
    removed = await asyncio.to_thread(reset_catalog, path)
    return {"reset": True, "removed": removed, "path": str(path)}
