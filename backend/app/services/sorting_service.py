"""Sorting service — orchestrates the full sort pipeline."""

from __future__ import annotations

import asyncio
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
from app.core.database import DatabaseManager
from app.core.logging_config import get_logger
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.dedup_index import DedupIndex, resolve_index_path
from app.services.destination import build_dest_dir, quarantine_dir, rename_stem
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
    validate_source_directory,
    validate_target_directory,
)
from app.services.junk_filter import classify_junk
from app.services.metadata_service import MetadataService
from app.services.repair_service import RepairService
from app.utils.media_utils import is_image, is_video
from app.utils.path_utils import (
    canonicalize_target,
    sanitize_path_segment,
    validate_source_target_overlap,
)

if TYPE_CHECKING:
    from app.background_tasks.task_manager import Task
    from app.services.ai.ai_tagging_service import AITaggingService
    from app.services.ai.category_classifier_service import CategoryClassifierService
    from app.services.rule_engine_service import RuleEngineService

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
) -> None:
    update = getattr(task, "update_progress", None)
    if callable(update):
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

    async def run(self, task: Task, dry_run: bool = False) -> dict[str, Any]:
        """Sort all media files from source to destination.

        Quarantine strategy:
        - No date extracted       → _unknown_dates/
        - Date in the future      → _future_dates/
        - Duplicate content       → _duplicates/  (never deleted)
        - Corrupted after copy    → _corrupted/
        - Any other error         → _failed/
        """
        config = self._config_service.get()
        rich_task = (
            task
            if all(
                hasattr(task, name) for name in ("transition", "update_progress", "mark_partial")
            )
            else None
        )
        cancel_signal = getattr(task, "cancel_token", task.cancel_event)
        _transition_task(task, "validating")
        source_root = await asyncio.to_thread(
            validate_source_directory,
            config.source_directory,
        )
        if config.target_directory:
            await asyncio.to_thread(
                validate_source_target_overlap,
                source_root,
                config.target_directory,
            )
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
        # Re-check after creation to close a symlink/junction identity change.
        await asyncio.to_thread(validate_source_target_overlap, source_root, dest_root)

        _transition_task(task, "scanning_source")
        traversal = await self._fs.traverse(
            source_root,
            recursive=config.recursive_scan,
            max_depth=config.max_recursion_depth,
            exclude_patterns=config.exclude_patterns,
            min_file_size_kb=config.min_file_size_kb,
            max_file_size_mb=config.max_file_size_mb,
            cancel_token=cancel_signal,
            task=rich_task,
        )
        files = traversal.files

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
            "operation_id": None,
        }

        operation_id = f"sort_{uuid.uuid4().hex[:12]}"
        start_time = time.monotonic()

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
                files,
                config,
                self._duplicates,
                cancel_signal,
                rich_task,
            )
        )
        records: list[dict[str, Any] | None] = [None] * len(files)

        # Per-file phase — reset the counter so the bar restarts cleanly from 0.
        if not cancel_signal.is_set():
            _transition_task(task, "sorting", total=len(files))

        for rank, idx in enumerate(order):
            if cancel_signal.is_set():
                logger.info("Sort cancelled by user", processed=rank, total=len(files))
                break

            # Dispatch the blocking per-file work off the event loop.
            record = await asyncio.to_thread(
                self._process_file,
                file_path=files[idx],
                source_root=source_root,
                dest_root=dest_root,
                config=config,
                dry_run=dry_run,
                registry=registry,
                operation_id=operation_id,
                dest_registry=dest_registry,
                cancel_signal=cancel_signal,
            )
            if record["status"] == "cancelled":
                break
            records[idx] = record

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

            # Progress + ETA
            elapsed = time.monotonic() - start_time
            eta: float | None = None
            if elapsed > 0 and rank > 0:
                rate = (rank + 1) / elapsed
                remaining = len(files) - (rank + 1)
                eta = remaining / rate
            _update_task(task, rank + 1, eta_seconds=eta)

        # Drop any unprocessed slots (e.g. after a cancel); keep original order.
        file_records: list[dict[str, Any]] = [r for r in records if r is not None]

        duration = int(time.monotonic() - start_time)
        stats["operation_id"] = operation_id

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
        cancel_signal: Any | None = None,
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
        }

        try:
            # Junk / thumbnail filter — cheapest check first; quarantined to
            # _junk/ with the reason in the record (never deleted).
            junk_reason = classify_junk(file_path, config)
            if junk_reason is not None:
                dest = self._quarantine_auto(
                    file_path, "junk", dest_root, dry_run, config, source_root
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
                    file_path, "unknown", dest_root, dry_run, config, source_root
                )
                record.update(status="unknown_date", dest_path=str(dest))
                return record

            record["extracted_date"] = str(extracted_date)

            # Future date — same copy-mode-aware quarantine as unknown dates.
            if DateExtractionService.is_future_date(extracted_date):
                dest = self._quarantine_auto(
                    file_path, "future", dest_root, dry_run, config, source_root
                )
                record.update(status="future_date", dest_path=str(dest))
                return record

            # Duplicate check (exact + perceptual for images and videos).
            # The match's scope decides the quarantine folder: "run" →
            # _duplicates/, "destination" → _already_in_destination/.
            # Duplicates are always quarantined, never deleted.
            if config.remove_duplicates:
                match: DuplicateMatch = self._duplicates.check_duplicate(
                    file_path,
                    registry,
                    exact=config.duplicate_exact_enabled,
                    perceptual=config.duplicate_perceptual_enabled,
                    threshold=config.duplicate_perceptual_threshold,
                    destination_registry=dest_registry,
                    cancel_token=cancel_signal,
                )
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
                            file_path, status, dest_root, dry_run, source_root
                        )
                    else:
                        # Move mode: the source is consumed into quarantine.
                        dest = self._quarantine(file_path, status, dest_root, dry_run, source_root)
                    record.update(status=status, dest_path=str(dest))
                    return record

            # Evaluate rule-based tags before building destination
            tags: list[str] = []
            if self._rules is not None:
                try:
                    tags = self._rules.evaluate(file_path)
                except Exception as exc:
                    logger.warning("Rule evaluation failed", path=str(file_path), error=str(exc))
            record["tags"] = tags

            # Smart Categorization: classify the SOURCE file (it hasn't moved
            # yet) into a topic folder before building the destination. Runs in
            # this worker thread, so CLIP inference never blocks the event loop.
            category: str | None = None
            if config.categorize_enabled and self._classifier is not None:
                category = self._classifier.classify_file(file_path).category
            record["category"] = category

            # Extract camera model once; raw value goes to the report, sanitized
            # value is used for the folder name inside _build_dest.
            raw_camera: str | None = None
            if config.camera_subfolder_enabled:
                raw_camera = self._extraction.extract_camera_model(file_path)
                record["camera_model"] = raw_camera

            # Build destination
            dest = self._build_dest(
                file_path,
                extracted_date,
                source_root,
                dest_root,
                config,
                category,
                sanitize_path_segment(raw_camera or ""),
            )

            if not dry_run:
                if cancel_signal is not None and cancel_signal.is_set():
                    raise DuplicateCheckCancelled
                if config.copy_instead_of_move:
                    self._fs.safe_copy(file_path, dest, verify=True)
                else:
                    self._fs.safe_move(file_path, dest)

                # Apply image conversion if configured
                if config.convert_images and is_image(dest):
                    try:
                        converted = self._conversion.convert_image(
                            source=dest,
                            target_format=config.image_format,
                            quality=90,
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
                    try:
                        converted = self._conversion.convert_video(
                            source=dest,
                            target_format=config.video_format,
                            quality="medium",
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

                # Apply renaming pattern in-place
                if config.rename:
                    dest = self._apply_rename(dest, extracted_date, config)

                # Override EXIF creation date if configured
                if config.override_metadata:
                    dt = datetime(extracted_date.year, extracted_date.month, extracted_date.day)
                    self._metadata.set_creation_date(dest, dt)

                # AI tagging (best-effort) on the final placed file: analyse the
                # content, merge the tags into the record, and optionally embed
                # them into the file itself (EXIF / video metadata / XMP sidecar).
                # Runs before the utime sync (a metadata rewrite changes mtime)
                # and before validation (so a bad write is still caught).
                if config.ai_tagging_enabled and self._ai is not None:
                    try:
                        ai_tags = self._ai.tag_file(dest)
                        if ai_tags:
                            record["tags"] = list(dict.fromkeys([*record["tags"], *ai_tags]))
                        if config.ai_tagging_embed_in_files and record["tags"]:
                            self._metadata.write_keywords(dest, record["tags"])
                    except Exception as exc:
                        logger.warning("AI tagging step failed", path=str(dest), error=str(exc))

                # Synchronise filesystem timestamps (mtime + atime) to the extracted date
                # so the file's "date modified" matches the photo/video date in all UIs.
                try:
                    extracted_ts = datetime(
                        extracted_date.year,
                        extracted_date.month,
                        extracted_date.day,
                    ).timestamp()
                    os.utime(dest, (extracted_ts, extracted_ts))
                except Exception as exc:
                    logger.debug("Could not set file timestamps", path=str(dest), error=str(exc))

                # Validate + repair if enabled (skipped entirely when repair_enabled=False)
                if config.repair_enabled:
                    is_valid, err = self._repair.validate_file(dest)
                    if not is_valid:
                        repaired = self._repair.repair_file(dest)
                        if not repaired:
                            dest = self._quarantine(
                                dest, "corrupted", dest_root, False, source_root
                            )
                            record.update(
                                status="corrupted", dest_path=str(dest), error_message=err
                            )
                            return record
                        logger.info("Repaired file after validation failure", path=str(dest))

            # A suspicious-EXIF file that recovered via a fallback date may have
            # set error_message above — clear it so success records never carry
            # failure evidence (the `suspicious` fields keep the reason).
            record.update(status="success", dest_path=str(dest), error_message=None)

        except DuplicateCheckCancelled:
            record["status"] = "cancelled"
            return record
        except Exception as exc:
            logger.error("Failed to process file", path=str(file_path), error=str(exc))
            try:
                # Copy mode: quarantine a *copy* — the source must survive even
                # a failed run (the failure may have struck after the file was
                # already placed, in which case the source is all the user has).
                dest = self._quarantine_auto(
                    file_path, "failed", dest_root, dry_run, config, source_root
                )
                record["dest_path"] = str(dest)
            except Exception:
                pass
            record["error_message"] = str(exc)

        return record

    # ------------------------------------------------------------------ #
    # Helpers                                                               #
    # ------------------------------------------------------------------ #

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
        """Compute a collision-free destination path. Pure path math — the
        directory tree is created by ``safe_copy``/``safe_move`` at placement
        time, so a dry run never mutates the destination volume.

        The sanitized camera string is pre-computed by the caller to avoid a
        second EXIF read.
        """
        dest_dir = build_dest_dir(
            file_path, extracted_date, source_root, dest_root, config, category, camera
        )
        return self._fs.find_available_filename(dest_dir / file_path.name)

    def _apply_rename(self, path: Path, d: date, config: Config) -> Path:
        """Apply config.rename_pattern to *path*, returning the renamed path.

        Supported tokens: YYYY, MM, DD, NAME, TYPE (substituted by the shared
        ``rename_stem`` so the preview predicts identical names).
        """
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
    ) -> Path:
        """Quarantine honouring the copy-mode invariant: in copy mode the source
        is copied into the quarantine folder and never touched; in move mode it
        is consumed (the original behaviour)."""
        if config.copy_instead_of_move:
            return self._quarantine_copy(file_path, reason, dest_root, dry_run, source_root)
        return self._quarantine(file_path, reason, dest_root, dry_run, source_root)

    def _quarantine(
        self,
        file_path: Path,
        reason: str,
        dest_root: Path,
        dry_run: bool,
        source_root: Path,
    ) -> Path:
        """Quarantine by moving (used in move mode). The source-relative
        subfolders are preserved inside the quarantine folder (P0-4: a large
        `_unknown_dates/` stays navigable and keeps its filename hints)."""
        folder = quarantine_dir(dest_root, reason, file_path, source_root)
        dest = self._fs.find_available_filename(folder / file_path.name)
        if not dry_run:
            self._fs.safe_move(file_path, dest)
        return dest

    def _quarantine_copy(
        self,
        file_path: Path,
        reason: str,
        dest_root: Path,
        dry_run: bool,
        source_root: Path,
    ) -> Path:
        """Quarantine by copying (used in copy mode — source is never touched)."""
        folder = quarantine_dir(dest_root, reason, file_path, source_root)
        dest = self._fs.find_available_filename(folder / file_path.name)
        if not dry_run:
            self._fs.safe_copy(file_path, dest, verify=True)
        return dest

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
                         junk_files, already_in_destination,
                         duration_seconds, config_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                         duplicate_of, suspicious)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        )
                        for r in file_records
                    ],
                )
            logger.info("Operation persisted to DB", operation_id=operation_id)
        except Exception as exc:
            logger.error("Failed to persist operation", operation_id=operation_id, error=str(exc))
