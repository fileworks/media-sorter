"""Sorting service — orchestrates the full sort pipeline."""

from __future__ import annotations

import asyncio
import contextlib
import hashlib
import json
import os
import tempfile
import time
import uuid
from datetime import date, datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.database import DatabaseManager
from app.core.integrity import (
    MutationActionKind,
    OperationOutcomeCode,
    PreservationProfile,
)
from app.core.integrity_policy import MutationAuthorization, authorize_config_mutations
from app.core.library_validation import validate_configured_library
from app.core.logging_config import get_logger
from app.core.media_units import CompanionRole, MediaUnit
from app.core.paths import resolve_app_paths
from app.core.provenance import OutcomeProvenance
from app.core.rules import normalized_key
from app.core.sort_plan import FrozenSortPlan
from app.services.ai.ai_tagging_service import AITaggingService
from app.services.ai.category_classifier_service import CategoryClassifierService, CategoryResult
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.dedup_index import DedupIndex, resolve_index_path
from app.services.destination import (
    build_dest_dir,
    companion_destination,
    predicted_filename,
    quarantine_dir,
    rename_stem,
    reserve_destination,
)
from app.services.duplicate_service import (
    DuplicateCheckCancelled,
    DuplicateMatch,
    DuplicateRegistry,
    DuplicateService,
    quality_processing_order,
)
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import (
    FileSystemService,
    validate_target_directory,
)
from app.services.junk_filter import classify_junk
from app.services.metadata_service import MetadataService
from app.services.operation_execution import OperationExecution
from app.services.outcome_provenance import build_outcome_provenance
from app.services.repair_service import RepairService
from app.services.rule_engine_service import RuleEngineService
from app.services.verified_transfer import TransferResult
from app.utils.media_utils import is_image, is_video
from app.utils.path_utils import (
    canonicalize_target,
    sanitize_path_segment,
)

if TYPE_CHECKING:
    from app.background_tasks.task_manager import Task

logger = get_logger(__name__)


def _transition_task(task: Any, phase: str, *, total: int = 0) -> None:
    transition = getattr(task, "transition", None)
    if callable(transition):
        transition(phase, total=total)
        return
    task.progress.phase = phase
    task.progress.current = 0
    task.progress.total = max(0, total)
    task.progress.percentage = 0.0


def _update_task(
    task: Any,
    current: int,
    *,
    total: int | None = None,
    eta_seconds: float | None = None,
    bytes_done: int | None = None,
) -> None:
    update = getattr(task, "update_progress", None)
    if callable(update):
        try:
            update(current, total=total, eta_seconds=eta_seconds, bytes_done=bytes_done)
        except TypeError:
            # A simpler task object (tests, CLI) may not accept byte counters.
            update(current, total=total, eta_seconds=eta_seconds)
        return
    if total is not None:
        task.progress.total = max(0, total)
    task.progress.current = max(0, current)
    task.progress.percentage = (
        round(task.progress.current / task.progress.total * 100, 1) if task.progress.total else 0.0
    )
    task.progress.estimated_time_remaining_seconds = eta_seconds


# Which sort-record status a duplicate match's scope produces; the same key
# selects the quarantine folder in QUARANTINE_FOLDERS.
_DUPLICATE_STATUS_BY_SCOPE = {
    "destination": "already_in_destination",
    "run": "duplicate",
}


def _tags_to_json(tags: list[str]) -> str:
    """Serialise a tag list as JSON so commas inside tag text are preserved."""
    return json.dumps(tags, ensure_ascii=False) if tags else "[]"


def _operation_outcome(stats: dict[str, Any], *, cancelled: bool) -> OperationOutcomeCode:
    if cancelled:
        return "cancelled"
    if stats["failed"] and stats["sorted"]:
        return "partial"
    if stats.get("incomplete_units"):
        return "partial"
    if stats["failed"]:
        return "failed"
    if stats["corrupted"] or stats["issues"] or stats["partial"]:
        return "completed_with_warnings"
    return "completed"


def root_identifier(root: Path) -> str:
    """A stable, bounded id for one root.

    The manifest already records each action's full observed path; ``root_id``
    exists to group actions by origin, so a short digest is both sufficient and
    safe for a length-limited identity field.
    """
    return f"root_{hashlib.sha256(str(root).encode('utf-8')).hexdigest()[:16]}"


def _relative_to(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return path.name


def _result_sha256(result: TransferResult) -> str | None:
    return result.integrity.observed_result_sha256 if result.integrity is not None else None


def _merge_tags(tags: list[str]) -> list[str]:
    """De-duplicate normalized tags while preserving first spelling and order."""
    merged: list[str] = []
    seen: set[str] = set()
    for tag in tags:
        key = normalized_key(tag)
        if key and key not in seen:
            seen.add(key)
            merged.append(tag)
    return merged


class SortingService:
    def __init__(
        self,
        config: Config,
        config_service: ConfigService,
        filesystem_service: FileSystemService,
        extraction_service: DateExtractionService,
        duplicate_service: DuplicateService,
        metadata_service: MetadataService,
        conversion_service: ConversionService,
        repair_service: RepairService,
        db_manager: DatabaseManager | None = None,
        rule_engine_service: RuleEngineService | None = None,
        ai_tagging_service: AITaggingService | None = None,
        category_classifier_service: CategoryClassifierService | None = None,
    ) -> None:
        self._config = config
        # Files whose planned name had to be suffixed because another file
        # claimed it first. Reset at the start of every run; reported live.
        self._collisions_planned = 0
        self._config_service = config_service
        self._fs = filesystem_service
        self._extraction = extraction_service
        self._duplicates = duplicate_service
        self._metadata = metadata_service
        self._conversion = conversion_service
        self._repair = repair_service
        self._db = db_manager
        self._rules = rule_engine_service
        self._ai = ai_tagging_service
        self._classifier = category_classifier_service

    async def run(
        self,
        task: Task,
        dry_run: bool = False,
        frozen_plan: FrozenSortPlan | None = None,
    ) -> dict[str, Any]:
        """Sort all media files from source to destination.

        Quarantine strategy:
        - No date extracted       → _unknown_dates/
        - Date in the future      → _future_dates/
        - Duplicate content       → _duplicates/  (never deleted)
        - Corrupted after copy    → _corrupted/
        - Any other error         → _failed/
        """
        config = self._config_service.get()
        if frozen_plan is not None and frozen_plan.config_fingerprint != config_fingerprint(config):
            raise ValueError(
                "The configuration changed after preview; generate and review a new plan."
            )
        rich_task = (
            task
            if all(
                hasattr(task, name) for name in ("transition", "update_progress", "mark_partial")
            )
            else None
        )
        cancel_signal = getattr(task, "cancel_token", task.cancel_event)
        _transition_task(task, "validating")
        authorization = authorize_config_mutations(config)
        library = await asyncio.to_thread(validate_configured_library, config)
        source_root = library.inputs[0].canonical_path
        if dry_run:
            if not config.target_directory.strip():
                dest_root = await asyncio.to_thread(
                    validate_target_directory,
                    config.target_directory,
                )
            else:
                dest_root = canonicalize_target(config.target_directory)
        else:
            dest_root = await asyncio.to_thread(
                validate_target_directory,
                config.target_directory,
            )
        # Re-check all typed roots after destination creation to close a
        # symlink/junction identity change.
        library = await asyncio.to_thread(validate_configured_library, config)
        source_root = library.inputs[0].canonical_path

        _transition_task(task, "scanning_source")
        # Every configured input contributes files, each remembering the root
        # it came from so relative layout and quarantine structure stay correct.
        enumerated = await self._fs.traverse_roots(
            [(item.canonical_path, item.exclusions) for item in library.inputs],
            recursive=config.recursive_scan,
            max_depth=config.max_recursion_depth,
            exclude_patterns=config.exclude_patterns,
            min_file_size_kb=config.min_file_size_kb,
            max_file_size_mb=config.max_file_size_mb,
            cancel_token=cancel_signal,
            task=rich_task,
            companion_handling=config.companion_handling,
        )
        traversal = enumerated.result
        root_of = enumerated.root_of
        files = traversal.files
        units = traversal.units
        primary_files = [unit.primary for unit in units]

        logger.info(
            "Sort started",
            source=config.source_directory,
            dest=config.target_directory,
            total=len(files),
            action="copy" if config.copy_instead_of_move else "move",
        )
        _update_task(task, 0, total=len(files))
        stats: dict[str, Any] = {
            "total": len(files),
            "sorted": 0,
            "failed": 0,
            "skipped": traversal.excluded_by_pattern + traversal.excluded_by_size,
            "partial": traversal.partial,
            "issues": [issue.to_dict() for issue in traversal.issues],
            "duplicates": 0,
            "future_dates": 0,
            "unknown_dates": 0,
            "corrupted": 0,
            "junk": 0,
            "already_in_destination": 0,
            "media_units": len(units),
            "companion_files": sum(len(unit.companions) for unit in units),
            "unmatched_companions": len(traversal.unmatched_companions),
            "incomplete_units": 0,
            "operation_id": None,
            "review_only": len(units) if not config.sort else 0,
        }

        if not config.sort:
            stats["operation_id"] = f"review_{uuid.uuid4().hex[:12]}"
            stats["outcome"] = "completed"
            logger.info("Review-only run completed without transfer", total=len(files))
            return stats

        operation_id = f"sort_{uuid.uuid4().hex[:12]}"
        start_time = time.monotonic()
        # Per-run counters. `collisions_reported` is the high-water mark already
        # pushed to the task, so the live tally is reported as a delta rather
        # than re-counted from zero on every file.
        self._collisions_planned = 0
        collisions_reported = 0
        protected_roots = tuple(item.canonical_path for item in library.references)
        execution = (
            None
            if dry_run
            else OperationExecution.start(
                operation_id=operation_id,
                state_root=resolve_app_paths().data_dir,
                preservation=config.preservation_profile,
                authorization=authorization,
                effective_config_sha256=config_fingerprint(config),
                protected_roots=protected_roots,
                frozen_plan=frozen_plan,
            )
        )

        # Per-operation in-memory duplicate registry
        registry = DuplicateRegistry()

        # Destination-aware / cross-run dedup: refresh the persistent
        # index of what already lives in the destination and load it as a
        # read-only registry. The refresh is incremental (stat-only for
        # unchanged files) and reports its own "indexing" phase so the bar
        # never sits frozen.
        dest_registry: DuplicateRegistry | None = None
        if config.remove_duplicates and not cancel_signal.is_set():
            temporary_index: tempfile.TemporaryDirectory[str] | None = None
            try:
                if dry_run:
                    temporary_index = tempfile.TemporaryDirectory(prefix="mediasort-preview-index-")
                    index_path = Path(temporary_index.name) / "dedup.sqlite3"
                else:
                    index_path = resolve_index_path(config)
                index = DedupIndex(index_path)
                await asyncio.to_thread(
                    index.refresh,
                    dest_root,
                    self._duplicates,
                    perceptual=config.duplicate_perceptual_enabled,
                    sample_video=True,
                    cancel_event=cancel_signal,
                    task=rich_task,
                )
                for reference in library.references:
                    # Comparison-only: the reference library is read to decide
                    # what is already covered, and is never itself organized.
                    await asyncio.to_thread(
                        index.refresh,
                        reference.canonical_path,
                        self._duplicates,
                        perceptual=config.duplicate_perceptual_enabled,
                        sample_video=True,
                        cancel_event=cancel_signal,
                        task=rich_task,
                    )
                dest_registry = await asyncio.to_thread(index.load_registry)
            finally:
                if temporary_index is not None:
                    temporary_index.cleanup()

        if cancel_signal.is_set():
            logger.info(
                "operation.cancellation_observed",
                task_id=getattr(task, "id", ""),
                phase="scanning_source",
            )

        # Keeper selection: when perceptual de-dup is on, process files in
        # descending quality order so the first file seen in each duplicate group
        # is its highest-resolution (then largest) copy — that copy is kept and
        # the lesser copies are quarantined. Records are placed back at their
        # original index so the report/preview order is unaffected.
        # Run the (blocking, header-reading) ordering pass off the event loop so
        # progress polling stays responsive; it bails on cancel. The pass reports
        # its own "ranking" phase so the bar moves during setup (plan Item 8).
        order = (
            []
            if cancel_signal.is_set()
            else await asyncio.to_thread(
                quality_processing_order,
                primary_files,
                config,
                self._duplicates,
                cancel_signal,
                rich_task,
            )
        )
        records: list[list[dict[str, Any]] | None] = [None] * len(units)
        reserved_destinations: set[Path] = set()
        bytes_done = 0
        # Snapshot locale-sensitive dependencies. A config update can replace
        # the container's live services while this coroutine is running; these
        # instances keep generated content coherent for this operation.
        operation_rules = (
            self._rules.for_operation(config)
            if isinstance(self._rules, RuleEngineService)
            else self._rules
        )
        operation_ai = (
            self._ai.for_operation(config) if isinstance(self._ai, AITaggingService) else self._ai
        )
        operation_classifier = (
            self._classifier.for_operation(config)
            if isinstance(self._classifier, CategoryClassifierService)
            else self._classifier
        )

        # Per-file phase — reset the counter so the bar restarts cleanly from 0.
        if not cancel_signal.is_set():
            _transition_task(task, "sorting", total=len(units))

        if execution is not None:
            execution.emit("operation.phase_changed", phase="sorting", total=len(units))

        for rank, idx in enumerate(order):
            if cancel_signal.is_set():
                logger.info("Sort cancelled by user", processed=rank, total=len(units))
                if execution is not None:
                    execution.emit(
                        "operation.cancellation_observed",
                        phase="sorting",
                        processed=rank,
                        total=len(units),
                    )
                if rich_task is not None:
                    rich_task.observe_cancellation()
                break

            # Dispatch the blocking per-file work off the event loop.
            unit_records = await asyncio.to_thread(
                self._process_unit,
                unit=units[idx],
                source_root=root_of.get(primary_files[idx], source_root),
                dest_root=dest_root,
                config=config,
                dry_run=dry_run,
                registry=registry,
                operation_id=operation_id,
                dest_registry=dest_registry,
                reserved_destinations=reserved_destinations,
                operation_rules=operation_rules,
                operation_ai=operation_ai,
                operation_classifier=operation_classifier,
                use_operation_services=True,
                cancel_signal=cancel_signal,
                execution=execution,
            )
            record = unit_records[0]
            if record["status"] == "cancelled":
                break
            records[idx] = unit_records

            status = record["status"]
            if status == "success":
                stats["sorted"] += 1
            elif status == "duplicate":
                stats["duplicates"] += 1
            elif status == "future_date":
                stats["future_dates"] += 1
            elif status == "unknown_date":
                stats["unknown_dates"] += 1
            elif status == "corrupted":
                stats["corrupted"] += 1
            elif status == "junk":
                stats["junk"] += 1
            elif status == "already_in_destination":
                stats["already_in_destination"] += 1
            else:
                stats["failed"] += 1
            if any(item["status"] == "incomplete_unit" for item in unit_records):
                stats["incomplete_units"] += 1

            if rich_task is not None:
                rich_task.record_outcome(status)
                if self._collisions_planned > collisions_reported:
                    rich_task.record_outcome(
                        "name_collision",
                        count=self._collisions_planned - collisions_reported,
                    )
                    collisions_reported = self._collisions_planned
                # Every completed file is a point a restart could resume from:
                # its placement is already verified and journalled.
                rich_task.checkpoint(f"file:{rank + 1}")

            # Progress + ETA
            elapsed = time.monotonic() - start_time
            eta: float | None = None
            if elapsed > 0 and rank > 0:
                rate = (rank + 1) / elapsed
                remaining = len(units) - (rank + 1)
                eta = remaining / rate
            bytes_done += int(record.get("file_size") or 0)
            _update_task(task, rank + 1, eta_seconds=eta, bytes_done=bytes_done)

        # Drop any unprocessed slots (e.g. after a cancel); keep original order.
        file_records = [
            record
            for unit_records in records
            if unit_records is not None
            for record in unit_records
        ]
        file_records.extend(
            {
                "id": str(uuid.uuid4()),
                "operation_id": operation_id,
                "source_path": str(finding.path),
                "dest_path": None,
                "extracted_date": None,
                "metadata_source": "none",
                "action": "none",
                "status": "unmatched_companion",
                "error_message": finding.reason,
                "file_size": self._safe_stat(finding.path),
                "file_type": finding.path.suffix.lower(),
                "tags": [],
                "category": None,
                "camera_model": None,
                "duplicate_type": None,
                "duplicate_similarity": None,
                "duplicate_of": None,
                "suspicious": False,
                "unit_id": None,
                "companion_role": finding.companion_role,
                "unit_primary_path": None,
            }
            for finding in traversal.unmatched_companions
        )

        duration = int(time.monotonic() - start_time)
        stats["operation_id"] = operation_id

        if execution is not None:
            operation_outcome = _operation_outcome(stats, cancelled=cancel_signal.is_set())
            report_path = await asyncio.to_thread(execution.store_report, operation_outcome)
            execution.finish(operation_outcome)
            stats["outcome"] = operation_outcome
            stats["integrity_report"] = str(report_path) if report_path else None

        if not dry_run:
            await asyncio.to_thread(
                self._persist_operation,
                operation_id=operation_id,
                config=config,
                stats=stats,
                duration=duration,
                file_records=file_records,
            )

        logger.info("Sort completed", **{k: v for k, v in stats.items() if k != "operation_id"})
        return stats

    # ------------------------------------------------------------------ #
    # Per-file processing                                                   #
    # ------------------------------------------------------------------ #

    def _process_unit(
        self,
        *,
        unit: MediaUnit,
        source_root: Path,
        dest_root: Path,
        config: Config,
        dry_run: bool,
        registry: DuplicateRegistry,
        operation_id: str,
        dest_registry: DuplicateRegistry | None,
        reserved_destinations: set[Path],
        operation_rules: RuleEngineService | None,
        operation_ai: AITaggingService | None,
        operation_classifier: CategoryClassifierService | None,
        use_operation_services: bool,
        cancel_signal: Any,
        execution: OperationExecution | None,
    ) -> list[dict[str, Any]]:
        """Process a primary first, then place its companions beside the result."""
        primary = self._process_file(
            file_path=unit.primary,
            source_root=source_root,
            dest_root=dest_root,
            config=config,
            dry_run=dry_run,
            registry=registry,
            operation_id=operation_id,
            dest_registry=dest_registry,
            reserved_destinations=reserved_destinations,
            operation_rules=operation_rules,
            operation_ai=operation_ai,
            operation_classifier=operation_classifier,
            use_operation_services=use_operation_services,
            cancel_signal=cancel_signal,
            execution=execution,
            unit_id=unit.unit_id,
            unit_primary_path=str(unit.primary),
        )
        primary.update(
            unit_id=unit.unit_id,
            companion_role=None,
            unit_primary_path=str(unit.primary),
        )
        records = [primary]
        if not unit.companions:
            return records

        primary_destination = primary.get("dest_path")
        can_place = primary["status"] not in {"failed", "cancelled", "corrupted"} and bool(
            primary_destination
        )
        for member in unit.companions:
            companion = self._new_companion_record(
                member.path,
                member.companion_role,
                unit,
                operation_id,
                config,
            )
            records.append(companion)
            if config.companion_handling == "leave_in_place":
                companion.update(
                    status="companion_left_in_place",
                    error_message="Companion intentionally left in source; unit split.",
                )
                continue
            if not can_place or cancel_signal.is_set():
                companion.update(
                    status="incomplete_unit",
                    error_message=(
                        "The primary or an earlier unit member did not commit."
                        if not can_place
                        else "Operation interrupted after the unit primary committed."
                    ),
                )
                can_place = False
                continue

            destination = companion_destination(Path(str(primary_destination)), member.path)
            companion["dest_path"] = str(destination)
            if dry_run:
                companion["status"] = "success"
                continue
            try:
                placement = self._place(
                    member.path,
                    destination,
                    kind="copy" if config.copy_instead_of_move else "move",
                    config=config,
                    execution=execution,
                    source_root=source_root,
                    unit_id=unit.unit_id,
                    companion_role=member.companion_role,
                    unit_primary_path=str(unit.primary),
                )
                companion.update(
                    status="success",
                    content_sha256=_result_sha256(placement),
                    commit_method=placement.commit_method,
                    source_safety=placement.source_safety,
                    preservation_warnings=list(placement.warnings),
                )
            except Exception as exc:
                logger.error(
                    "Companion placement failed",
                    unit_id=unit.unit_id,
                    path=str(member.path),
                    error=str(exc),
                )
                companion.update(status="incomplete_unit", error_message=str(exc))
                if execution is not None:
                    execution.record_failure(
                        action_id=f"unit_{unit.unit_id}",
                        source_path=member.path,
                        code="incomplete_unit",
                        diagnostic_code=type(exc).__name__,
                    )
                can_place = False
                continue
        return records

    def _new_companion_record(
        self,
        path: Path,
        role: CompanionRole | None,
        unit: MediaUnit,
        operation_id: str,
        config: Config,
    ) -> dict[str, Any]:
        extracted_date: str | None = None
        with contextlib.suppress(Exception):
            detail = self._extraction.extract_detailed(path, check_suspicious=False)
            if detail.extracted_date is not None:
                extracted_date = str(detail.extracted_date)
        return {
            "id": str(uuid.uuid4()),
            "operation_id": operation_id,
            "source_path": str(path),
            "dest_path": None,
            "extracted_date": extracted_date,
            "metadata_source": "report_only",
            "action": "copy" if config.copy_instead_of_move else "move",
            "status": "failed",
            "error_message": None,
            "file_size": self._safe_stat(path),
            "file_type": path.suffix.lower(),
            "tags": [],
            "category": None,
            "camera_model": None,
            "duplicate_type": None,
            "duplicate_similarity": None,
            "duplicate_of": None,
            "suspicious": False,
            "unit_id": unit.unit_id,
            "companion_role": role,
            "unit_primary_path": str(unit.primary),
            "content_sha256": None,
            "commit_method": None,
            "source_safety": "source_retained",
            "preservation_warnings": [],
        }

    def _process_file(
        self,
        file_path: Path,
        source_root: Path,
        dest_root: Path,
        config: Config,
        dry_run: bool,
        registry: DuplicateRegistry,
        operation_id: str,
        dest_registry: DuplicateRegistry | None = None,
        reserved_destinations: set[Path] | None = None,
        operation_rules: RuleEngineService | None = None,
        operation_ai: AITaggingService | None = None,
        operation_classifier: CategoryClassifierService | None = None,
        use_operation_services: bool = False,
        cancel_signal: Any | None = None,
        execution: OperationExecution | None = None,
        unit_id: str | None = None,
        unit_primary_path: str | None = None,
    ) -> dict[str, Any]:
        """Process a single file through the full sort pipeline.

        This is a *synchronous* method — it performs blocking I/O (copy,
        ffmpeg, Pillow, SHA-256, subprocess) and must be dispatched via
        asyncio.to_thread from the async run() loop.

        One bad file never aborts the batch: the outer except always quarantines
        the file to _failed/ and records a non-empty error_message.
        """
        record: dict[str, Any] = {
            "id": str(uuid.uuid4()),
            "operation_id": operation_id,
            "source_path": str(file_path),
            "dest_path": None,
            "extracted_date": None,
            "metadata_source": None,
            "action": "copy" if config.copy_instead_of_move else "move",
            "status": "failed",
            "error_message": None,
            "file_size": self._safe_stat(file_path),
            "file_type": file_path.suffix.lower(),
            "tags": [],
            "category": None,
            "camera_model": None,
            "duplicate_type": None,
            "duplicate_similarity": None,
            "duplicate_of": None,
            "suspicious": False,
            "content_sha256": None,
            "commit_method": None,
            "source_safety": None,
            "preservation_warnings": [],
            "derived_date_applied": False,
            "tags_written": "",
        }
        preservation = config.preservation_profile
        authorization = (
            execution.authorization if execution is not None else authorize_config_mutations(config)
        )

        try:
            rules = operation_rules if use_operation_services else self._rules
            ai = operation_ai if use_operation_services else self._ai
            classifier = operation_classifier if use_operation_services else self._classifier
            rule_tags: list[str] = []
            route_suffix: str | None = None
            evaluation: Any | None = None
            if rules is not None:
                try:
                    evaluation = rules.evaluate_all(file_path)
                    rule_tags = list(evaluation.tags)
                    route_suffix = evaluation.route
                except Exception as exc:
                    logger.warning("Rule evaluation failed", path=str(file_path), error=str(exc))
            record["tags"] = rule_tags

            # Junk / thumbnail filter — cheapest check first; quarantined to
            # _junk/ with the reason in the record (never deleted).
            junk_reason = classify_junk(file_path, config)
            if junk_reason is not None:
                dest = self._quarantine_auto(
                    file_path, "junk", dest_root, dry_run, config, source_root, execution
                )
                record.update(status="junk", dest_path=str(dest), error_message=junk_reason)
                return record

            result = self._extraction.extract_detailed(
                file_path, check_suspicious=config.exif_sanity_check_enabled
            )
            extracted_date = result.extracted_date
            meta_source = result.source
            record["metadata_source"] = meta_source
            record["suspicious"] = bool(result.suspicious)
            if result.suspicious:
                logger.warning(
                    "Suspicious EXIF date",
                    path=str(file_path),
                    reason=result.suspicious_reason,
                    fallback=str(result.fallback_date) if result.fallback_date else None,
                )
                record["error_message"] = f"Suspicious EXIF: {result.suspicious_reason}"

            # Unknown date — quarantined respecting the copy-mode invariant
            # (in copy mode the source is copied to _unknown_dates/, never moved).
            if extracted_date is None:
                dest = self._quarantine_auto(
                    file_path, "unknown", dest_root, dry_run, config, source_root, execution
                )
                record.update(status="unknown_date", dest_path=str(dest))
                return record

            record["extracted_date"] = str(extracted_date)

            # Future date — same copy-mode-aware quarantine as unknown dates.
            if DateExtractionService.is_future_date(extracted_date):
                dest = self._quarantine_auto(
                    file_path, "future", dest_root, dry_run, config, source_root, execution
                )
                record.update(status="future_date", dest_path=str(dest))
                return record

            # Duplicate check (exact + perceptual for images and videos).
            # The match's scope decides the quarantine folder: "run" →
            # _duplicates/, "destination" → _already_in_destination/.
            # Duplicates are always quarantined, never deleted.
            match = DuplicateMatch(False)
            if config.remove_duplicates:
                match = self._duplicates.check_duplicate(
                    file_path,
                    registry,
                    exact=config.duplicate_exact_enabled,
                    perceptual=config.duplicate_perceptual_enabled,
                    threshold=config.duplicate_perceptual_threshold,
                    destination_registry=dest_registry,
                    cancel_token=cancel_signal,
                )
                # Reuse the hash the duplicate check already paid for, so
                # authorizing the placement costs no second full read.
                record["content_sha256"] = match.content_sha256
                if match.is_duplicate:
                    status = _DUPLICATE_STATUS_BY_SCOPE.get(match.scope or "run", "duplicate")
                    record["duplicate_type"] = match.match_type
                    record["duplicate_similarity"] = match.similarity
                    record["duplicate_of"] = match.original_path
                    logger.info(
                        "Duplicate detected",
                        path=str(file_path),
                        match_type=match.match_type,
                        similarity=match.similarity,
                        original=match.original_path,
                        scope=match.scope or "run",
                    )
                    if config.copy_instead_of_move:
                        # Copy mode: the duplicate is copied into its quarantine
                        # folder without touching the source.
                        dest = self._quarantine_copy(
                            file_path, status, dest_root, dry_run, source_root, execution
                        )
                    else:
                        # Move mode: the source is consumed into quarantine.
                        dest = self._quarantine(
                            file_path, status, dest_root, dry_run, source_root, execution
                        )
                    record.update(status=status, dest_path=str(dest))
                    return record

            # Smart Categorization: classify the SOURCE file (it hasn't moved
            # yet) into a topic folder before building the destination. Runs in
            # this worker thread, so CLIP inference never blocks the event loop.
            category: str | None = None
            category_result = CategoryResult(None, 0.0, 0.0)
            if config.categorize_enabled and classifier is not None:
                category_result = classifier.classify_file(file_path)
                category = category_result.category
            record["category"] = category

            # Extract camera model once; raw value goes to the report, sanitized
            # value is used for the folder name inside _build_dest.
            raw_camera: str | None = None
            if config.camera_subfolder_enabled:
                raw_camera = self._extraction.extract_camera_model(file_path)
                record["camera_model"] = raw_camera

            # Build destination
            initial_dest, planned_final = self._plan_dest(
                file_path,
                extracted_date,
                source_root,
                dest_root,
                config,
                category,
                sanitize_path_segment(raw_camera or ""),
                route_suffix,
                reserved_destinations,
            )
            dest = initial_dest
            provenance = build_outcome_provenance(
                file_path=file_path,
                source_root=source_root,
                destination=planned_final,
                config=config,
                extraction=result,
                rules=evaluation,
                category=category_result,
                duplicate_evaluated=config.remove_duplicates,
                duplicate_type=match.match_type,
                duplicate_similarity=match.similarity,
                duplicate_of=match.original_path,
                duplicate_evaluation=match.evaluation,
                route_suffix=route_suffix,
                camera=sanitize_path_segment(raw_camera or ""),
                unit_id=unit_id,
                unit_members=(str(file_path),),
            )
            record["provenance"] = provenance.model_dump(mode="json")

            if not dry_run:
                if cancel_signal is not None and cancel_signal.is_set():
                    raise DuplicateCheckCancelled
                if execution is not None:
                    execution.verify_reviewed_destination(
                        file_path,
                        planned_final,
                        unit_id=unit_id,
                    )
                # Destination contents may have changed since planning. Recheck
                # immediately before writing and never open an existing path.
                dest = self._fs.find_available_filename(dest)
                placement = self._place(
                    file_path,
                    dest,
                    kind="copy" if config.copy_instead_of_move else "move",
                    config=config,
                    execution=execution,
                    source_root=source_root,
                    known_sha256=record.get("content_sha256"),
                    unit_id=unit_id,
                    unit_primary_path=unit_primary_path,
                    provenance=provenance,
                )
                dest = placement.destination_path
                record["content_sha256"] = _result_sha256(placement)
                record["commit_method"] = placement.commit_method
                record["source_safety"] = placement.source_safety
                record["preservation_warnings"] = list(placement.warnings)
                record["timestamps_requested_ns"] = placement.requested_metadata.mtime_ns
                record["timestamps_observed_ns"] = placement.observed_metadata.mtime_ns

                # Apply image conversion if configured. Conversion replaces media
                # bytes, so it may only run against a reviewed profile — the
                # policy guard, never a bare config boolean, is the boundary.
                if config.convert_images and is_image(dest):
                    authorization.require("conversion")
                    try:
                        converted = self._conversion.convert_image(
                            source=dest,
                            target_format=config.image_format,
                            quality=config.image_quality,
                            preserve_exif=True,
                        )
                        if converted != dest:
                            dest.unlink(missing_ok=True)
                            dest = converted
                    except Exception as exc:
                        logger.warning(
                            "Image conversion failed; keeping original",
                            path=str(dest),
                            error=str(exc),
                        )

                # Apply video conversion if configured
                if config.convert_videos and is_video(dest):
                    authorization.require("conversion")
                    try:
                        converted = self._conversion.convert_video(
                            source=dest,
                            target_format=config.video_format,
                            quality=config.video_quality,
                        )
                        if converted != dest:
                            dest.unlink(missing_ok=True)
                            dest = converted
                    except Exception as exc:
                        logger.warning(
                            "Video conversion failed; keeping original",
                            path=str(dest),
                            error=str(exc),
                        )

                # Conversion/rename planning chooses the final name before any
                # mutation. If conversion kept the expected suffix, move to that
                # reserved name; a post-preview destination mutation simply
                # advances the deterministic suffix and is reported below.
                if (
                    dest.suffix.casefold() == planned_final.suffix.casefold()
                    and dest != planned_final
                ):
                    target = self._fs.find_available_filename(planned_final)
                    dest.rename(target)
                    dest = target

                # Override EXIF creation date if configured. This rewrites media
                # bytes, so Organize Only records the correction in the report
                # instead — see the derived-metadata handling below.
                if config.override_metadata:
                    authorization.require("embedded_metadata")
                    dt = datetime(extracted_date.year, extracted_date.month, extracted_date.day)
                    self._metadata.set_creation_date(dest, dt)

                # AI tagging (best-effort) on the final placed file: analyse the
                # content, merge the tags into the record, and optionally embed
                # them into the file itself (EXIF / video metadata / XMP sidecar).
                # Runs before the utime sync (a metadata rewrite changes mtime)
                # and before validation (so a bad write is still caught).
                if config.ai_tagging_enabled and ai is not None:
                    try:
                        ai_tags = ai.tag_file(dest)
                        if ai_tags:
                            record["tags"] = _merge_tags([*record["tags"], *ai_tags])
                    except Exception as exc:
                        logger.warning("AI tagging step failed", path=str(dest), error=str(exc))
                record["tags_written"] = self._write_derived_tags(
                    dest,
                    record["tags"],
                    config=config,
                    preservation=preservation,
                    authorization=authorization,
                )

                # Filesystem timestamps: Organize Only keeps the originals and
                # reports the derived media date instead of overwriting evidence
                # of when the file was actually created on disk.
                if preservation.preserve_filesystem_timestamps:
                    record["derived_date_applied"] = False
                else:
                    try:
                        extracted_ts = datetime(
                            extracted_date.year,
                            extracted_date.month,
                            extracted_date.day,
                        ).timestamp()
                        os.utime(dest, (extracted_ts, extracted_ts))
                        record["derived_date_applied"] = True
                    except Exception as exc:
                        logger.debug(
                            "Could not set file timestamps", path=str(dest), error=str(exc)
                        )

                # Validate + repair if enabled (skipped entirely when repair_enabled=False)
                if config.repair_enabled:
                    authorization.require("repair")
                    is_valid, err = self._repair.validate_file(dest)
                    if not is_valid:
                        repaired = self._repair.repair_file(dest)
                        if not repaired:
                            dest = self._quarantine(
                                dest, "corrupted", dest_root, False, source_root, execution
                            )
                            record.update(
                                status="corrupted", dest_path=str(dest), error_message=err
                            )
                            return record
                        logger.info("Repaired file after validation failure", path=str(dest))
            else:
                dest = planned_final

            # A suspicious-EXIF file that recovered via a fallback date may have
            # set error_message above — clear it so success records never carry
            # failure evidence (the `suspicious` fields keep the reason).
            record.update(status="success", dest_path=str(dest), error_message=None)

        except DuplicateCheckCancelled:
            record["status"] = "cancelled"
            return record
        except Exception as exc:
            logger.error("Failed to process file", path=str(file_path), error=str(exc))
            if execution is not None:
                execution.emit(
                    "action.issue",
                    phase="sorting",
                    source_path=str(file_path),
                    reason=type(exc).__name__,
                )
            try:
                # Copy mode: quarantine a *copy* — the source must survive even
                # a failed run (the failure may have struck after the file was
                # already placed, in which case the source is all the user has).
                dest = self._quarantine_auto(
                    file_path, "failed", dest_root, dry_run, config, source_root, execution
                )
                record["dest_path"] = str(dest)
            except Exception:
                pass
            record["error_message"] = str(exc)

        return record

    # ------------------------------------------------------------------ #
    # Helpers                                                               #
    # ------------------------------------------------------------------ #

    def _place(
        self,
        source: Path,
        destination: Path,
        *,
        kind: MutationActionKind,
        config: Config,
        execution: OperationExecution | None,
        source_root: Path,
        known_sha256: str | None = None,
        unit_id: str | None = None,
        companion_role: CompanionRole | None = None,
        unit_primary_path: str | None = None,
        provenance: OutcomeProvenance | None = None,
    ) -> TransferResult:
        """Move media only through the authorized, journalled, verified executor.

        Without a run-scoped execution (a direct ``_process_file`` call, as tests
        make) the same verified transfer still runs; only the manifest and
        journal records are absent.
        """
        move = not config.copy_instead_of_move
        if execution is None:
            return (
                self._fs.safe_move(source, destination)
                if move
                else self._fs.safe_copy(source, destination)
            )
        return execution.place(
            source,
            destination,
            kind=kind,
            move=move,
            root_id=root_identifier(source_root),
            relative_path=_relative_to(source, source_root),
            known_sha256=known_sha256,
            unit_id=unit_id,
            companion_role=companion_role,
            unit_primary_path=unit_primary_path,
            provenance=provenance,
        )

    def _write_derived_tags(
        self,
        dest: Path,
        tags: list[str],
        *,
        config: Config,
        preservation: PreservationProfile,
        authorization: MutationAuthorization,
    ) -> str:
        """Record derived tags without touching media bytes by default.

        Embedding rewrites the file, so it needs an explicitly reviewed profile.
        Otherwise the tags go to the operation report, plus a standards-shaped
        sidecar when the profile asks for one.
        """
        if not tags:
            return ""
        if config.embed_tags_in_files:
            authorization.require("embedded_metadata")
            try:
                return self._metadata.write_keywords(dest, tags)
            except Exception as exc:
                logger.warning("Tag embedding failed", path=str(dest), error=str(exc))
                return ""
        if preservation.derived_metadata == "sidecar_and_report":
            try:
                return "sidecar" if self._metadata.write_sidecar(dest, tags) else "report"
            except Exception as exc:
                logger.warning("Sidecar write failed", path=str(dest), error=str(exc))
                return "report"
        return "report"

    def _build_dest(
        self,
        file_path: Path,
        extracted_date: date,
        source_root: Path,
        dest_root: Path,
        config: Config,
        category: str | None = None,
        camera: str = "",
    ) -> Path:
        """Compatibility helper for the pre-planner destination calculation."""
        dest_dir = build_dest_dir(
            file_path, extracted_date, source_root, dest_root, config, category, camera
        )
        return self._fs.find_available_filename(dest_dir / file_path.name)

    def _plan_dest(
        self,
        file_path: Path,
        extracted_date: date,
        source_root: Path,
        dest_root: Path,
        config: Config,
        category: str | None = None,
        camera: str = "",
        route_suffix: str | None = None,
        reserved_destinations: set[Path] | None = None,
    ) -> tuple[Path, Path]:
        """Compute a collision-free destination path. Pure path math — the
        directory tree is created by ``safe_copy``/``safe_move`` at placement
        time, so a dry run never mutates the destination volume.

        The sanitized camera string is pre-computed by the caller to avoid a
        second EXIF read.
        """
        dest_dir = build_dest_dir(
            file_path,
            extracted_date,
            source_root,
            dest_root,
            config,
            category,
            camera,
            route_suffix,
        )
        wanted = dest_dir / predicted_filename(file_path, extracted_date, config)
        final = wanted
        if reserved_destinations is not None:
            final = reserve_destination(final, reserved_destinations)
        else:
            final = self._fs.find_available_filename(final)
        # A changed name means two files wanted the same one and this is the
        # loser. Counting it is what lets the run report "3 name collisions
        # auto-suffixed" instead of silently producing files nobody expected.
        self._collisions_planned += int(final != wanted)
        initial = final.with_suffix(file_path.suffix)
        return initial, final

    def _apply_rename(self, path: Path, d: date, config: Config) -> Path:
        """Compatibility helper using the shared single-pass rename tokens."""
        file_type = "VID" if is_video(path) else "IMG"
        new_stem = rename_stem(config.rename_pattern, d, path.stem, file_type)
        new_path = self._fs.find_available_filename(path.parent / (new_stem + path.suffix))
        path.rename(new_path)
        return new_path

    def _quarantine_auto(
        self,
        file_path: Path,
        reason: str,
        dest_root: Path,
        dry_run: bool,
        config: Config,
        source_root: Path,
        execution: OperationExecution | None = None,
    ) -> Path:
        """Quarantine honouring the copy-mode invariant: in copy mode the source
        is copied into the quarantine folder and never touched; in move mode it
        is consumed (the original behaviour)."""
        if config.copy_instead_of_move:
            return self._quarantine_copy(
                file_path, reason, dest_root, dry_run, source_root, execution
            )
        return self._quarantine(file_path, reason, dest_root, dry_run, source_root, execution)

    def _quarantine(
        self,
        file_path: Path,
        reason: str,
        dest_root: Path,
        dry_run: bool,
        source_root: Path,
        execution: OperationExecution | None = None,
    ) -> Path:
        """Quarantine by moving (used in move mode). The source-relative
        subfolders are preserved inside the quarantine folder (P0-4: a large
        `_unknown_dates/` stays navigable and keeps its filename hints)."""
        folder = quarantine_dir(dest_root, reason, file_path, source_root)
        dest = self._fs.find_available_filename(folder / file_path.name)
        if not dry_run:
            self._quarantine_transfer(file_path, dest, source_root, execution, move=True)
        return dest

    def _quarantine_copy(
        self,
        file_path: Path,
        reason: str,
        dest_root: Path,
        dry_run: bool,
        source_root: Path,
        execution: OperationExecution | None = None,
    ) -> Path:
        """Quarantine by copying (used in copy mode — source is never touched)."""
        folder = quarantine_dir(dest_root, reason, file_path, source_root)
        dest = self._fs.find_available_filename(folder / file_path.name)
        if not dry_run:
            self._quarantine_transfer(file_path, dest, source_root, execution, move=False)
        return dest

    def _quarantine_transfer(
        self,
        source: Path,
        destination: Path,
        source_root: Path,
        execution: OperationExecution | None,
        *,
        move: bool,
    ) -> None:
        """Quarantine through the same verified executor as ordinary placement."""
        if execution is None:
            if move:
                self._fs.safe_move(source, destination)
            else:
                self._fs.safe_copy(source, destination)
            return
        result = execution.place(
            source,
            destination,
            kind="quarantine",
            move=move,
            root_id=root_identifier(source_root),
            relative_path=_relative_to(source, source_root),
        )
        execution.outcomes[-1] = execution.outcomes[-1].model_copy(update={"code": "quarantined"})
        del result

    @staticmethod
    def _safe_stat(path: Path) -> int:
        try:
            return path.stat().st_size
        except OSError:
            return 0

    # ------------------------------------------------------------------ #
    # DB persistence                                                        #
    # ------------------------------------------------------------------ #

    def _persist_operation(
        self,
        operation_id: str,
        config: Config,
        stats: dict[str, Any],
        duration: int,
        file_records: list[dict[str, Any]],
    ) -> None:
        """Persist the completed operation to SQLite.

        This is a *synchronous* method and must be called via asyncio.to_thread.
        """
        if self._db is None:
            return
        try:
            # Compute a short stable hash of the run config for auditing.
            config_hash = hashlib.sha256(
                json.dumps(config.to_dict(), sort_keys=True, default=str).encode()
            ).hexdigest()[:16]

            with self._db._connect() as conn:
                conn.execute(
                    """
                    INSERT INTO operations
                        (id, execution_date, source_path, dest_path, total_files,
                         files_sorted, files_failed, files_skipped, duplicates_found,
                         future_dates, unknown_dates, corrupted_files,
                         junk_files, already_in_destination, companion_files,
                         incomplete_units,
                         duration_seconds, config_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    (
                        operation_id,
                        datetime.now(timezone.utc).isoformat(),
                        config.source_directory,
                        config.target_directory,
                        stats["total"],
                        stats["sorted"],
                        stats["failed"],
                        stats["skipped"],
                        stats["duplicates"],
                        stats["future_dates"],
                        stats["unknown_dates"],
                        stats["corrupted"],
                        stats["junk"],
                        stats["already_in_destination"],
                        stats["companion_files"],
                        stats["incomplete_units"],
                        duration,
                        config_hash,
                    ),
                )
                conn.executemany(
                    """
                    INSERT INTO file_operations
                        (id, operation_id, source_path, dest_path, extracted_date,
                         metadata_source, action, status, error_message, file_size, file_type,
                         tags, category, camera_model, duplicate_type, duplicate_similarity,
                         duplicate_of, suspicious, unit_id, companion_role, unit_primary_path)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            r["id"],
                            r["operation_id"],
                            r["source_path"],
                            r["dest_path"],
                            r["extracted_date"],
                            r["metadata_source"],
                            r["action"],
                            r["status"],
                            r["error_message"],
                            r["file_size"],
                            r["file_type"],
                            _tags_to_json(r.get("tags", [])),
                            r.get("category"),
                            r.get("camera_model"),
                            r.get("duplicate_type"),
                            r.get("duplicate_similarity"),
                            r.get("duplicate_of"),
                            1 if r.get("suspicious") else 0,
                            r.get("unit_id"),
                            r.get("companion_role"),
                            r.get("unit_primary_path"),
                        )
                        for r in file_records
                    ],
                )
            logger.info("Operation persisted to DB", operation_id=operation_id)
        except Exception as exc:
            logger.error("Failed to persist operation", operation_id=operation_id, error=str(exc))
