"""Preview service — dry-run scan showing predicted sort output."""

from __future__ import annotations

import asyncio
import contextlib
import tempfile
import time
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.config import Config
from app.core.exceptions import ConfigError
from app.core.logging_config import get_logger
from app.services.dedup_index import DedupIndex
from app.services.destination import build_dest_dir, predicted_filename, quarantine_dir
from app.services.duplicate_service import (
    DuplicateCheckCancelled,
    DuplicateMatch,
    DuplicateRegistry,
    DuplicateService,
    quality_processing_order,
)
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import FileSystemService, validate_source_directory
from app.services.junk_filter import classify_junk
from app.utils.path_utils import sanitize_path_segment, validate_source_target_overlap

if TYPE_CHECKING:
    from app.background_tasks.task_manager import Task
    from app.services.ai.category_classifier_service import CategoryClassifierService
    from app.services.rule_engine_service import RuleEngineService

logger = get_logger(__name__)


class PreviewService:
    def __init__(
        self,
        filesystem_service: FileSystemService,
        extraction_service: DateExtractionService,
        rule_engine_service: RuleEngineService | None,
        duplicate_service: DuplicateService | None = None,
        category_classifier_service: CategoryClassifierService | None = None,
    ) -> None:
        self._fs = filesystem_service
        self._extraction = extraction_service
        self._rules = rule_engine_service
        self._dups = duplicate_service
        self._classifier = category_classifier_service

    async def run_preview(self, task: Task, config: Config) -> dict[str, Any]:
        """Task-manager entry point: run the preview while reporting progress.

        Mirrors ``SortingService.run`` so the frontend can poll a real
        percentage instead of waiting on one opaque request.
        """
        return await self.preview(config, task=task)

    async def preview(self, config: Config, task: Task | None = None) -> dict[str, Any]:
        """Return a dry-run prediction of what a sort run would produce.

        When a ``task`` is supplied, per-file progress (current/total/percentage
        + ETA) and a coarse ``phase`` are reported on it and cancellation is
        honored. The heavy per-file work (EXIF/probe + duplicate hashing) is
        dispatched off the event loop so progress polling stays responsive on
        large libraries. The setup work before the per-file loop (directory scan,
        quality ranking) reports its own phases so the bar never sits frozen at
        0%.
        """
        # Phase 1 — directory scan (no incremental count available, so the UI
        # shows an indeterminate "Scanning folder…" bar).
        logger.info("Preview started", source=str(config.source_directory))
        if task is not None:
            task.transition("validating")
        # A preview is read-only, so only the source is checked here — but it is
        # checked, so a missing folder says so instead of previewing nothing.
        source_root = validate_source_directory(config.source_directory)
        if not config.target_directory.strip():
            raise ConfigError("No destination folder is set. Choose one before previewing.")
        _, dest_root = validate_source_target_overlap(source_root, config.target_directory)
        if task is not None:
            task.transition("scanning_source")
        traversal = await self._fs.traverse(
            source_root,
            recursive=config.recursive_scan,
            max_depth=config.max_recursion_depth,
            exclude_patterns=config.exclude_patterns,
            min_file_size_kb=config.min_file_size_kb,
            max_file_size_mb=config.max_file_size_mb,
            cancel_token=task.cancel_token if task is not None else None,
            task=task,
        )
        files = traversal.files
        total = len(files)
        logger.info("Preview: scan complete", total=total)
        if task is not None:
            task.update_progress(0, total=total)

        stats: dict[str, Any] = {
            "total": total,
            "excluded_files": traversal.excluded_files,
            "partial": traversal.partial,
            "issue_count": len(traversal.issues),
            "will_sort": 0,
            "will_fail": 0,
            "will_quarantine_unknown": 0,
            "will_quarantine_future": 0,
            "will_skip_duplicate": 0,
            "will_quarantine_junk": 0,
            "will_skip_already_in_destination": 0,
            "duplicate_unknown": 0,
            # Sorted files that fell below the categorization confidence bar and
            # are predicted to land in _uncategorized/ (always present; 0 when the
            # feature is off).
            "uncategorized": 0,
        }

        # Per-preview in-memory duplicate registry (mirrors SortingService).
        registry = DuplicateRegistry()
        check_suspicious = config.exif_sanity_check_enabled
        start_time = time.monotonic()

        # Destination-aware dedup uses an ephemeral index so preview stays
        # read-only while still comparing every existing destination item.
        # Missing video signatures are not computed here (no ffmpeg on preview).
        dest_registry: DuplicateRegistry | None = None
        if (
            config.remove_duplicates
            and self._dups is not None
            and not (task is not None and task.cancel_token.is_set())
        ):
            with tempfile.TemporaryDirectory(prefix="mediasort-preview-index-") as index_dir:
                index = DedupIndex(Path(index_dir) / "dedup.sqlite3")
                await asyncio.to_thread(
                    index.refresh,
                    dest_root,
                    self._dups,
                    perceptual=config.duplicate_perceptual_enabled,
                    sample_video=False,
                    cancel_event=task.cancel_event if task is not None else None,
                    task=task,
                )
                dest_registry = await asyncio.to_thread(index.load_registry)

        if task is not None and task.cancel_token.is_set():
            return {
                "items": [],
                "stats": stats,
                "partial": traversal.partial,
                "issues": [issue.to_dict() for issue in traversal.issues],
            }

        # Phase 2 — quality ranking (only when perceptual de-dup is on). Process
        # best-quality-first within duplicate groups (same quality_key as
        # SortingService) so the kept "original" is predicted as the best copy;
        # items are placed back at their original index to preserve list order.
        # The pre-pass reads image headers per file, so it reports its own
        # "ranking" progress instead of leaving the bar at 0%.
        cancel_event = task.cancel_event if task is not None else None
        order = await asyncio.to_thread(
            quality_processing_order, files, config, self._dups, cancel_event, task
        )
        slots: list[dict[str, Any] | None] = [None] * total

        if task is not None and task.cancel_token.is_set():
            return {
                "items": [],
                "stats": stats,
                "partial": traversal.partial,
                "issues": [issue.to_dict() for issue in traversal.issues],
            }

        # Phase 3 — per-file prediction. Reset the counter so the bar restarts
        # cleanly from 0 under the "previewing" label.
        if task is not None:
            task.transition("previewing", total=total)

        for rank, idx in enumerate(order):
            if task is not None and task.cancel_event.is_set():
                break

            # Offload the blocking per-file work so the event loop (and thus
            # progress polling) is never starved on big directories.
            item = await asyncio.to_thread(
                self._preview_file,
                files[idx],
                source_root,
                dest_root,
                config,
                registry,
                check_suspicious,
                dest_registry,
                task.cancel_token if task is not None else None,
            )
            slots[idx] = item
            self._bump_stats(stats, item["status"])
            if item.get("duplicate_evaluation") == "unknown":
                stats["duplicate_unknown"] += 1
            # A "sort" item with no category (and categorization enabled) is
            # routed to _uncategorized/ — count it for the summary.
            if (
                config.categorize_enabled
                and item["status"] == "sort"
                and item.get("category") is None
            ):
                stats["uncategorized"] += 1

            if task is not None:
                elapsed = time.monotonic() - start_time
                eta: float | None = None
                if elapsed > 0 and rank > 0:
                    rate = (rank + 1) / elapsed
                    eta = (total - (rank + 1)) / rate
                task.update_progress(rank + 1, eta_seconds=eta)

        items: list[dict[str, Any]] = [it for it in slots if it is not None]
        logger.info(
            "Preview complete",
            will_sort=stats["will_sort"],
            duplicates=stats["will_skip_duplicate"],
            quarantine_unknown=stats["will_quarantine_unknown"],
            quarantine_future=stats["will_quarantine_future"],
            uncategorized=stats["uncategorized"],
        )
        return {
            "items": items,
            "stats": stats,
            "partial": traversal.partial,
            "issues": [issue.to_dict() for issue in traversal.issues],
        }

    # ------------------------------------------------------------------ #
    # Per-file prediction                                                   #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _bump_stats(stats: dict[str, Any], status: str) -> None:
        if status == "sort":
            stats["will_sort"] += 1
        elif status == "failed":
            stats["will_fail"] += 1
        elif status == "future_date":
            stats["will_quarantine_future"] += 1
        elif status == "duplicate":
            stats["will_skip_duplicate"] += 1
        elif status == "junk":
            stats["will_quarantine_junk"] += 1
        elif status == "already_in_destination":
            stats["will_skip_already_in_destination"] += 1
        else:  # unknown_date / suspicious_date both land in _unknown_dates
            stats["will_quarantine_unknown"] += 1

    def _preview_file(
        self,
        file_path: Path,
        source_root: Path,
        dest_root: Path,
        config: Config,
        registry: DuplicateRegistry,
        check_suspicious: bool,
        dest_registry: DuplicateRegistry | None = None,
        cancel_token: Any | None = None,
    ) -> dict[str, Any]:
        """Predict the outcome for a single file.

        Synchronous (blocking) — dispatched via ``asyncio.to_thread`` from
        ``preview``. One bad file never aborts the batch: any exception is
        surfaced as a ``failed`` item so ``stats["will_fail"]`` stays meaningful.
        """
        try:
            file_size = file_path.stat().st_size
        except OSError:
            file_size = 0

        # Junk / thumbnail filter — mirrors the sort exactly (same classifier,
        # same quarantine path), so the preview's promise holds.
        junk_reason = classify_junk(file_path, config)
        if junk_reason is not None:
            return {
                "source": str(file_path),
                "destination": str(
                    quarantine_dir(dest_root, "junk", file_path, source_root) / file_path.name
                ),
                "extracted_date": None,
                "metadata_source": "none",
                "tags": [],
                "category": None,
                "status": "junk",
                "file_size": file_size,
                "suspicious": False,
                "suspicious_reason": None,
                "quarantine_reason": junk_reason,
                "duplicate_type": None,
                "duplicate_similarity": None,
                "duplicate_of": None,
                "duplicate_evaluation": "known",
                "duplicate_unknown_reason": None,
            }

        try:
            extr = self._extraction.extract_detailed(file_path, check_suspicious=check_suspicious)
        except Exception:
            logger.error("Preview: prediction failed", path=str(file_path))
            return {
                "source": str(file_path),
                "destination": str(dest_root / "_failed" / file_path.name),
                "extracted_date": None,
                "metadata_source": "none",
                "tags": [],
                "category": None,
                "status": "failed",
                "file_size": file_size,
                "suspicious": False,
                "suspicious_reason": None,
                "quarantine_reason": None,
                "duplicate_type": None,
                "duplicate_similarity": None,
                "duplicate_of": None,
                "duplicate_evaluation": "known",
                "duplicate_unknown_reason": None,
            }

        extracted_date = extr.extracted_date
        source = extr.source

        # Apply rule-based tags
        tags: list[str] = []
        if self._rules is not None:
            with contextlib.suppress(Exception):
                tags = self._rules.evaluate(file_path)

        status: str
        dest: str | None
        category: str | None = None
        dup_type: str | None = None
        dup_similarity: int | None = None
        dup_of: str | None = None
        dup_evaluation = "known"
        dup_unknown_reason: str | None = None

        if extracted_date is None:
            status = "suspicious_date" if extr.suspicious else "unknown_date"
            dest = str(
                quarantine_dir(dest_root, "unknown", file_path, source_root) / file_path.name
            )
            logger.warning(
                "Preview: quarantine (no date)",
                path=file_path.name,
                reason=extr.suspicious_reason if extr.suspicious else "no date found",
            )

        elif DateExtractionService.is_future_date(extracted_date):
            status = "future_date"
            dest = str(quarantine_dir(dest_root, "future", file_path, source_root) / file_path.name)
            logger.warning(
                "Preview: quarantine (future date)",
                path=file_path.name,
                date=str(extracted_date),
            )

        elif config.remove_duplicates:
            match = self._dup_match(
                file_path,
                registry,
                exact=config.duplicate_exact_enabled,
                perceptual=config.duplicate_perceptual_enabled,
                threshold=config.duplicate_perceptual_threshold,
                destination_registry=dest_registry,
                cancel_token=cancel_token,
            )
            dup_evaluation = match.evaluation
            dup_unknown_reason = match.unknown_reason
            if match.is_duplicate:
                # Match scope → status/folder, exactly like the sort:
                # run → _duplicates/, destination → _already_in_destination/.
                status = {
                    "destination": "already_in_destination",
                }.get(match.scope or "run", "duplicate")
                # Mirror the sort: duplicates always land in their quarantine
                # folder (never deleted).
                dest = str(
                    quarantine_dir(dest_root, status, file_path, source_root) / file_path.name
                )
                dup_type = match.match_type
                dup_similarity = match.similarity
                dup_of = match.original_path
                logger.info(
                    "Preview: duplicate detected",
                    path=file_path.name,
                    match_type=dup_type,
                    similarity=dup_similarity,
                    duplicate_of=dup_of,
                    scope=match.scope or "run",
                )
            elif match.evaluation == "unknown":
                # The real sort samples video frames and may route this file as
                # a duplicate. Do not promise a date destination in preview.
                status = "duplicate_unknown"
                dest = None
            else:
                category = self._classify(file_path, config)
                status, dest = self._build_dest_path(
                    file_path, extracted_date, source_root, dest_root, config, category
                )
                if category:
                    logger.info(
                        "Preview: category assigned",
                        path=file_path.name,
                        category=category,
                        date=str(extracted_date),
                    )

        else:
            category = self._classify(file_path, config)
            status, dest = self._build_dest_path(
                file_path, extracted_date, source_root, dest_root, config, category
            )
            if category:
                logger.info(
                    "Preview: category assigned",
                    path=file_path.name,
                    category=category,
                    date=str(extracted_date),
                )

        return {
            "source": str(file_path),
            "destination": dest,
            "extracted_date": str(extracted_date) if extracted_date else None,
            "metadata_source": source,
            "tags": tags,
            "category": category,
            "status": status,
            "file_size": file_size,
            "suspicious": extr.suspicious,
            "suspicious_reason": extr.suspicious_reason if extr.suspicious else None,
            "quarantine_reason": None,
            "duplicate_type": dup_type,
            "duplicate_similarity": dup_similarity,
            "duplicate_of": dup_of,
            "duplicate_evaluation": dup_evaluation,
            "duplicate_unknown_reason": dup_unknown_reason,
        }

    # ------------------------------------------------------------------ #
    # Helpers                                                               #
    # ------------------------------------------------------------------ #

    def _classify(self, file_path: Path, config: Config) -> str | None:
        """Predict the topic category for *file_path*, or ``None`` (uncategorized)."""
        if not config.categorize_enabled or self._classifier is None:
            return None
        return self._classifier.classify_file(file_path).category

    def _build_dest_path(
        self,
        file_path: Path,
        extracted_date: date,
        source_root: Path,
        dest_root: Path,
        config: Config,
        category: str | None = None,
    ) -> tuple[str, str]:
        """Predict the destination via the shared builder SortingService uses.

        ``predicted_filename`` accounts for format conversion and the rename
        pattern, so the preview shows the name the sort will actually produce
        (collision suffixes like ``_001`` excepted — those depend on disk state).
        """
        camera = ""
        if config.camera_subfolder_enabled:
            camera = sanitize_path_segment(self._extraction.extract_camera_model(file_path) or "")
        dest_dir = build_dest_dir(
            file_path, extracted_date, source_root, dest_root, config, category, camera
        )
        return "sort", str(dest_dir / predicted_filename(file_path, extracted_date, config))

    def _dup_match(
        self,
        file_path: Path,
        registry: DuplicateRegistry,
        *,
        exact: bool = True,
        perceptual: bool = True,
        threshold: int = 95,
        destination_registry: DuplicateRegistry | None = None,
        cancel_token: Any | None = None,
    ) -> DuplicateMatch:
        """Non-destructive duplicate check via DuplicateService.

        Passes ``sample_video=False`` so the preview path never shells out to
        ffmpeg for per-video frame extraction.  Image perceptual checks (cheap)
        still run.
        """
        if self._dups is None:
            return DuplicateMatch(False)
        try:
            return self._dups.check_duplicate(
                file_path,
                registry,
                exact=exact,
                perceptual=perceptual,
                threshold=threshold,
                sample_video=False,
                destination_registry=destination_registry,
                cancel_token=cancel_token,
            )
        except DuplicateCheckCancelled:
            raise
        except Exception:
            return DuplicateMatch(False)
