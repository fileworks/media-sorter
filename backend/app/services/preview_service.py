"""Preview service — dry-run scan showing predicted sort output."""

from __future__ import annotations

import asyncio
import contextlib
import json
import shutil
import sqlite3
import tempfile
import time
from collections.abc import Iterable
from datetime import date
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.config import Config
from app.core.config_fingerprint import config_fingerprint
from app.core.exceptions import ConfigError
from app.core.integrity_policy import authorize_config_mutations
from app.core.library_validation import validate_configured_library
from app.core.logging_config import get_logger
from app.core.paths import resolve_app_paths
from app.core.sort_plan import FrozenSortPlan, build_frozen_sort_plan
from app.services.ai.category_classifier_service import CategoryClassifierService, CategoryResult
from app.services.catalog_indexing import index_library_roots
from app.services.dedup_index import DedupIndex
from app.services.destination import (
    build_dest_dir,
    companion_destination,
    predicted_filename,
    quarantine_dir,
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
from app.services.filesystem_service import FileSystemService
from app.services.junk_filter import classify_junk
from app.services.rule_engine_service import RuleEngineService
from app.utils.media_utils import is_image, is_video
from app.utils.path_utils import sanitize_path_segment

if TYPE_CHECKING:
    from app.background_tasks.task_manager import Task

logger = get_logger(__name__)


class PreviewOutcomeStore:
    """Disk-backed inspector records; reads are bounded by the API request cap."""

    def __init__(self, path: Path) -> None:
        self.path = path
        with contextlib.closing(sqlite3.connect(path)) as connection, connection:
            connection.execute(
                """
                CREATE TABLE IF NOT EXISTS outcomes (
                    source TEXT PRIMARY KEY,
                    payload TEXT NOT NULL
                )
                """
            )

    def replace(self, items: Iterable[dict[str, Any]]) -> None:
        with contextlib.closing(sqlite3.connect(self.path)) as connection, connection:
            connection.execute("DELETE FROM outcomes")
            connection.executemany(
                "INSERT INTO outcomes (source, payload) VALUES (?, ?)",
                (
                    (
                        str(item["source"]),
                        json.dumps(_outcome_payload(item), separators=(",", ":")),
                    )
                    for item in items
                ),
            )

    def get(self, paths: list[str]) -> list[dict[str, Any]]:
        if not paths:
            return []
        unique = tuple(dict.fromkeys(paths[:500]))
        placeholders = ",".join("?" for _ in unique)
        with contextlib.closing(sqlite3.connect(self.path)) as connection:
            rows = connection.execute(
                f"SELECT source, payload FROM outcomes WHERE source IN ({placeholders})",
                unique,
            ).fetchall()
        by_source = {str(row[0]): json.loads(str(row[1])) for row in rows}
        return [by_source[path] for path in unique if path in by_source]


def _outcome_payload(item: dict[str, Any]) -> dict[str, Any]:
    provenance = item.get("provenance")
    date_record = provenance.get("date", {}) if isinstance(provenance, dict) else {}
    return {
        "source": str(item["source"]),
        "resolved_date": item.get("extracted_date"),
        "candidates": date_record.get("candidates", []),
        "provenance": provenance,
    }


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
        self._latest_config_fingerprint: str | None = None
        self._outcome_directory = Path(tempfile.mkdtemp(prefix="mediasort-preview-outcomes-"))
        self._outcomes = PreviewOutcomeStore(self._outcome_directory / "outcomes.sqlite3")
        self._plans: dict[str, FrozenSortPlan] = {}

    def latest_outcomes(self, paths: list[str]) -> tuple[str | None, list[dict[str, Any]]]:
        """Return provenance recorded by the last completed preview.

        Review surfaces consume this snapshot instead of recomputing decisions
        from today's configuration.
        """
        return self._latest_config_fingerprint, self._outcomes.get(paths)

    def close(self) -> None:
        """Release disk-backed preview state without waiting for garbage collection."""
        directory = getattr(self, "_outcome_directory", None)
        if directory is not None:
            shutil.rmtree(directory, ignore_errors=True)

    def __del__(self) -> None:
        with contextlib.suppress(Exception):
            self.close()

    def frozen_plan(self, plan_id: str) -> FrozenSortPlan | None:
        return self._plans.get(plan_id)

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
        authorize_config_mutations(config)
        library = validate_configured_library(config)
        source_root = library.inputs[0].canonical_path
        if library.destination is None:  # guaranteed above; keeps the type contract explicit
            raise ConfigError("No destination folder is set. Choose one before previewing.")
        dest_root = library.destination.canonical_path
        if task is not None:
            task.transition("scanning_source")
        enumerated = await self._fs.traverse_roots(
            [(item.canonical_path, item.exclusions) for item in library.inputs],
            recursive=config.recursive_scan,
            max_depth=config.max_recursion_depth,
            exclude_patterns=config.exclude_patterns,
            min_file_size_kb=config.min_file_size_kb,
            max_file_size_mb=config.max_file_size_mb,
            cancel_token=task.cancel_token if task is not None else None,
            task=task,
            companion_handling=config.companion_handling,
        )
        traversal = enumerated.result
        root_of = enumerated.root_of
        files = traversal.files
        units = traversal.units
        primary_files = [unit.primary for unit in units]
        total = len(files)
        logger.info("Preview: scan complete", total=total)
        if task is not None:
            task.update_progress(0, total=total)

        stats: dict[str, Any] = {
            "total": total,
            "eligible_media": total,
            "media_units": len(units),
            "companions": sum(len(unit.companions) for unit in units),
            "unmatched_companions": len(traversal.unmatched_companions),
            "companion_split_warnings": 0,
            "conversion_companion_warnings": 0,
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
            "review_only": 0,
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
            quality_processing_order, primary_files, config, self._dups, cancel_event, task
        )
        slots: list[dict[str, Any] | None] = [None] * len(units)
        reserved_destinations: set[Path] = set()
        operation_rules = (
            self._rules.for_operation(config)
            if isinstance(self._rules, RuleEngineService)
            else self._rules
        )
        operation_classifier = (
            self._classifier.for_operation(config)
            if isinstance(self._classifier, CategoryClassifierService)
            else self._classifier
        )

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
            task.transition("previewing", total=len(units))

        for rank, idx in enumerate(order):
            if task is not None and task.cancel_event.is_set():
                break

            # Offload the blocking per-file work so the event loop (and thus
            # progress polling) is never starved on big directories.
            item = await asyncio.to_thread(
                self._preview_file,
                primary_files[idx],
                root_of.get(primary_files[idx], source_root),
                dest_root,
                config,
                registry,
                check_suspicious,
                dest_registry,
                operation_rules,
                operation_classifier,
                True,
                task.cancel_token if task is not None else None,
            )
            slots[idx] = item
            if item.get("destination"):
                proposed = Path(item["destination"])
                reserved = reserve_destination(proposed, reserved_destinations)
                item["destination"] = str(reserved)
                if reserved != proposed:
                    provenance = item.get("provenance")
                    if isinstance(provenance, dict):
                        path_segments = provenance.setdefault("path", [])
                        path_segments.append(
                            {
                                "segment": reserved.name,
                                "decision": "collision",
                                "detail": f"reserved after collision with {proposed.name}",
                            }
                        )
            unit = units[idx]
            unit_warnings: list[str] = []
            companions: list[dict[str, Any]] = []
            conversion_warning = bool(unit.companions) and (
                (config.convert_images and is_image(unit.primary))
                or (config.convert_videos and is_video(unit.primary))
            )
            if conversion_warning:
                unit_warnings.append(
                    "Companion contents are preserved; internal references are not rewritten "
                    "after conversion."
                )
                stats["conversion_companion_warnings"] += 1
            for member in unit.companions:
                destination: str | None = None
                status = "attached"
                warning: str | None = None
                if config.companion_handling == "leave_in_place":
                    status = "left_in_place"
                    warning = "This companion will remain in the source and the unit will split."
                    stats["companion_split_warnings"] += 1
                elif item.get("destination"):
                    destination = str(
                        companion_destination(Path(str(item["destination"])), member.path)
                    )
                member_date: str | None = None
                with contextlib.suppress(Exception):
                    detail = self._extraction.extract_detailed(member.path, check_suspicious=False)
                    member_date = (
                        None if detail.extracted_date is None else str(detail.extracted_date)
                    )
                companions.append(
                    {
                        "source": str(member.path),
                        "destination": destination,
                        "role": member.companion_role,
                        "status": status,
                        "warning": warning,
                        "extracted_date": member_date,
                        "placement_date_source": str(unit.primary),
                    }
                )
            item.update(
                unit_id=unit.unit_id,
                unit_primary=True,
                companions=companions,
                unit_warnings=unit_warnings,
            )
            provenance = item.get("provenance")
            if isinstance(provenance, dict):
                provenance["unit"] = {
                    "unit_id": unit.unit_id,
                    "role": "primary",
                    "members": [str(member.path) for member in unit.members][:32],
                }
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
                    eta = (len(units) - (rank + 1)) / rate
                task.update_progress(rank + 1, eta_seconds=eta)

        items: list[dict[str, Any]] = [it for it in slots if it is not None]

        # Fill the persistent index the duplicate workbench reads. The plan
        # already knows which files are copies of each other, but Review's
        # per-group evidence — sizes, dimensions, roles, confidence — comes
        # from the catalog, and nothing else populates it. Advisory: a failure
        # costs the richer view, never the plan.
        await asyncio.to_thread(
            index_library_roots,
            config.library_profile,
            data_dir=resolve_app_paths().data_dir,
            recursive=config.recursive_scan,
            max_depth=config.max_recursion_depth,
            exclude_patterns=tuple(config.exclude_patterns or ()),
            cancel=(lambda: task.cancel_event.is_set()) if task is not None else None,
        )

        logger.info(
            "Preview complete",
            will_sort=stats["will_sort"],
            duplicates=stats["will_skip_duplicate"],
            quarantine_unknown=stats["will_quarantine_unknown"],
            quarantine_future=stats["will_quarantine_future"],
            uncategorized=stats["uncategorized"],
        )
        fingerprint = config_fingerprint(config)
        self._latest_config_fingerprint = fingerprint
        self._outcomes.replace(items)
        plan = build_frozen_sort_plan(items, config)
        # Only the current reviewed plan remains executable. A stale identifier
        # can therefore never silently select an older set of consequences.
        self._plans = {plan.plan_id: plan}
        return {
            "config_fingerprint": fingerprint,
            "plan_id": plan.plan_id,
            "impact": plan.impact.model_dump(mode="json"),
            "items": items,
            "stats": stats,
            "partial": traversal.partial,
            "issues": [issue.to_dict() for issue in traversal.issues],
            "unmatched_companions": [
                {
                    "source": str(item.path),
                    "role": item.companion_role,
                    "reason": item.reason,
                }
                for item in traversal.unmatched_companions
            ],
        }

    # ------------------------------------------------------------------ #
    # Per-file prediction                                                   #
    # ------------------------------------------------------------------ #

    @staticmethod
    def _bump_stats(stats: dict[str, Any], status: str) -> None:
        if status == "sort":
            stats["will_sort"] += 1
        elif status == "review_only":
            stats["review_only"] += 1
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
        operation_rules: RuleEngineService | None = None,
        operation_classifier: CategoryClassifierService | None = None,
        use_operation_services: bool = False,
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

        # Apply deterministic rules to the untouched source. The route result is
        # used only if the file reaches the normal dated path below.
        rules = operation_rules if use_operation_services else self._rules
        classifier = operation_classifier if use_operation_services else self._classifier
        tags: list[str] = []
        route_suffix: str | None = None
        rule_evaluation: Any | None = None
        if rules is not None:
            with contextlib.suppress(Exception):
                rule_evaluation = rules.evaluate_all(file_path)
                tags = list(rule_evaluation.tags)
                route_suffix = rule_evaluation.route

        status: str
        dest: str | None
        category: str | None = None
        dup_type: str | None = None
        dup_similarity: int | None = None
        dup_of: str | None = None
        dup_evaluation = "known"
        dup_unknown_reason: str | None = None
        category_result = CategoryResult(None, 0.0, 0.0)

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
                category_result = self._classify(file_path, config, classifier)
                category = category_result.category
                status, dest = self._build_dest_path(
                    file_path,
                    extracted_date,
                    source_root,
                    dest_root,
                    config,
                    category,
                    route_suffix,
                )
                if category:
                    logger.info(
                        "Preview: category assigned",
                        path=file_path.name,
                        category=category,
                        date=str(extracted_date),
                    )

        else:
            category_result = self._classify(file_path, config, classifier)
            category = category_result.category
            status, dest = self._build_dest_path(
                file_path,
                extracted_date,
                source_root,
                dest_root,
                config,
                category,
                route_suffix,
            )
            if category:
                logger.info(
                    "Preview: category assigned",
                    path=file_path.name,
                    category=category,
                    date=str(extracted_date),
                )

        if not config.sort:
            status = "review_only"
            dest = None

        item: dict[str, Any] = {
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
        item["provenance"] = self._provenance(
            file_path=file_path,
            source_root=source_root,
            destination=Path(dest) if dest else None,
            config=config,
            extraction=extr,
            rules=rule_evaluation,
            category=category_result,
            duplicate_evaluated=config.remove_duplicates,
            duplicate_type=dup_type,
            duplicate_similarity=dup_similarity,
            duplicate_of=dup_of,
            duplicate_evaluation=dup_evaluation,
            route_suffix=route_suffix,
        )
        return item

    # ------------------------------------------------------------------ #
    # Helpers                                                               #
    # ------------------------------------------------------------------ #

    def _classify(
        self,
        file_path: Path,
        config: Config,
        classifier: CategoryClassifierService | None = None,
    ) -> CategoryResult:
        """Return the classifier's actual decision record, not a display reconstruction."""
        active_classifier = classifier if classifier is not None else self._classifier
        if not config.categorize_enabled or active_classifier is None:
            return CategoryResult(None, 0.0, 0.0)
        return active_classifier.classify_file(file_path)

    def _provenance(
        self,
        *,
        file_path: Path,
        source_root: Path,
        destination: Path | None,
        config: Config,
        extraction: Any,
        rules: Any | None,
        category: CategoryResult,
        duplicate_evaluated: bool,
        duplicate_type: str | None,
        duplicate_similarity: int | None,
        duplicate_of: str | None,
        duplicate_evaluation: str,
        route_suffix: str | None,
    ) -> dict[str, Any]:
        """Serialize the shared bounded decisions produced during prediction."""
        from app.services.outcome_provenance import build_outcome_provenance

        model = build_outcome_provenance(
            file_path=file_path,
            source_root=source_root,
            destination=destination,
            config=config,
            extraction=extraction,
            rules=rules,
            category=category,
            duplicate_evaluated=duplicate_evaluated,
            duplicate_type=duplicate_type,
            duplicate_similarity=duplicate_similarity,
            duplicate_of=duplicate_of,
            duplicate_evaluation=duplicate_evaluation,
            route_suffix=route_suffix,
        )
        return model.model_dump(mode="json")

    def _build_dest_path(
        self,
        file_path: Path,
        extracted_date: date,
        source_root: Path,
        dest_root: Path,
        config: Config,
        category: str | None = None,
        route_suffix: str | None = None,
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
            file_path,
            extracted_date,
            source_root,
            dest_root,
            config,
            category,
            camera,
            route_suffix,
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
