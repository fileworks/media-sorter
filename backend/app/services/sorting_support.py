"""Focused placement and persistence helpers for the sorting pipeline."""

from __future__ import annotations

import contextlib
import hashlib
import json
from datetime import date, datetime, timezone
from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.config import Config
from app.core.integrity import MutationActionKind, PreservationProfile
from app.core.integrity_policy import MutationAuthorization
from app.core.logging_config import get_logger
from app.core.media_units import CompanionRole
from app.core.provenance import OutcomeProvenance
from app.services.ai.category_classifier_service import CategoryClassifierService
from app.services.destination import (
    build_dest_dir,
    predicted_filename,
    quarantine_dir,
    rename_stem,
    reserve_destination,
)
from app.services.extraction_service import DateExtractionService
from app.services.junk_filter import classify_junk
from app.services.operation_execution import OperationExecution
from app.services.rule_engine_service import RuleEngineService
from app.services.verified_transfer import TransferResult
from app.utils.media_utils import is_video
from app.utils.path_utils import sanitize_path_segment

if TYPE_CHECKING:
    from app.core.database import DatabaseManager
    from app.services.filesystem_service import FileSystemService
    from app.services.metadata_service import MetadataService

logger = get_logger(__name__)


def _tags_to_json(tags: list[str]) -> str:
    """Serialise tags as JSON so commas inside tag text are preserved."""
    return json.dumps(tags, ensure_ascii=False) if tags else "[]"


def root_identifier(root: Path) -> str:
    """Return a stable, bounded identifier used to group actions by root."""
    return f"root_{hashlib.sha256(str(root).encode('utf-8')).hexdigest()[:16]}"


def _relative_to(path: Path, root: Path) -> str:
    try:
        return str(path.relative_to(root))
    except ValueError:
        return path.name


class SortingSupportMixin:
    """Placement, quarantine, destination-planning, and persistence support."""

    _fs: FileSystemService
    _metadata: MetadataService
    _extraction: DateExtractionService
    _db: DatabaseManager | None
    _collisions_planned: int

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
        """Place media through the authorized, journalled, verified executor."""
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
        """Record derived tags without touching media bytes by default."""
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

    def _predict_keeper_destination(
        self,
        keeper: Path,
        source_root: Path,
        dest_root: Path,
        config: Config,
        rules: RuleEngineService | None,
        classifier: CategoryClassifierService | None,
    ) -> Path:
        """Predict a keeper path when no reviewed frozen plan supplied one."""
        if classify_junk(keeper, config) is not None:
            return quarantine_dir(dest_root, "junk", keeper, source_root) / keeper.name
        try:
            extraction = self._extraction.extract_detailed(
                keeper, check_suspicious=config.exif_sanity_check_enabled
            )
        except Exception:
            return quarantine_dir(dest_root, "failed", keeper, source_root) / keeper.name
        if extraction.extracted_date is None:
            return quarantine_dir(dest_root, "unknown", keeper, source_root) / keeper.name
        if DateExtractionService.is_future_date(extraction.extracted_date):
            return quarantine_dir(dest_root, "future", keeper, source_root) / keeper.name

        route_suffix: str | None = None
        if rules is not None:
            with contextlib.suppress(Exception):
                route_suffix = rules.evaluate_all(keeper).route
        category: str | None = None
        if config.categorize_enabled and classifier is not None:
            category = classifier.classify_file(keeper).category
        camera = ""
        if config.camera_subfolder_enabled:
            camera = sanitize_path_segment(self._extraction.extract_camera_model(keeper) or "")
        folder = build_dest_dir(
            keeper,
            extraction.extracted_date,
            source_root,
            dest_root,
            config,
            category,
            camera,
            route_suffix,
        )
        return folder / predicted_filename(keeper, extraction.extracted_date, config)

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
        """Compute a collision-free destination path without mutating storage."""
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
        if reserved_destinations is not None:
            final = reserve_destination(wanted, reserved_destinations)
        else:
            final = self._fs.find_available_filename(wanted)
        self._collisions_planned += int(final != wanted)
        initial = final.with_suffix(file_path.suffix)
        return initial, final

    def _apply_rename(self, path: Path, extracted_date: date, config: Config) -> Path:
        """Compatibility helper using the shared single-pass rename tokens."""
        file_type = "VID" if is_video(path) else "IMG"
        new_stem = rename_stem(config.rename_pattern, extracted_date, path.stem, file_type)
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
        *,
        planned_destination: Path | None = None,
        unit_id: str | None = None,
    ) -> Path:
        """Quarantine by copy or move according to the reviewed run mode."""
        if config.copy_instead_of_move:
            return self._quarantine_copy(
                file_path,
                reason,
                dest_root,
                dry_run,
                source_root,
                execution,
                planned_destination=planned_destination,
                unit_id=unit_id,
            )
        return self._quarantine(
            file_path,
            reason,
            dest_root,
            dry_run,
            source_root,
            execution,
            planned_destination=planned_destination,
            unit_id=unit_id,
        )

    def _quarantine(
        self,
        file_path: Path,
        reason: str,
        dest_root: Path,
        dry_run: bool,
        source_root: Path,
        execution: OperationExecution | None = None,
        *,
        planned_destination: Path | None = None,
        unit_id: str | None = None,
    ) -> Path:
        """Quarantine by moving while retaining source-relative subfolders."""
        folder = quarantine_dir(dest_root, reason, file_path, source_root)
        dest = planned_destination or self._fs.find_available_filename(folder / file_path.name)
        if not dry_run:
            self._quarantine_transfer(
                file_path,
                dest,
                source_root,
                execution,
                move=True,
                unit_id=unit_id,
            )
        return dest

    def _quarantine_copy(
        self,
        file_path: Path,
        reason: str,
        dest_root: Path,
        dry_run: bool,
        source_root: Path,
        execution: OperationExecution | None = None,
        *,
        planned_destination: Path | None = None,
        unit_id: str | None = None,
    ) -> Path:
        """Quarantine by copying so the source remains untouched."""
        folder = quarantine_dir(dest_root, reason, file_path, source_root)
        dest = planned_destination or self._fs.find_available_filename(folder / file_path.name)
        if not dry_run:
            self._quarantine_transfer(
                file_path,
                dest,
                source_root,
                execution,
                move=False,
                unit_id=unit_id,
            )
        return dest

    def _quarantine_transfer(
        self,
        source: Path,
        destination: Path,
        source_root: Path,
        execution: OperationExecution | None,
        *,
        move: bool,
        provenance: OutcomeProvenance | None = None,
        unit_id: str | None = None,
    ) -> None:
        """Quarantine through the same verified executor as normal placement."""
        if execution is None:
            if move:
                self._fs.safe_move(source, destination)
            else:
                self._fs.safe_copy(source, destination)
            return
        execution.place(
            source,
            destination,
            kind="quarantine",
            move=move,
            root_id=root_identifier(source_root),
            relative_path=_relative_to(source, source_root),
            unit_id=unit_id,
            provenance=provenance,
        )
        execution.outcomes[-1] = execution.outcomes[-1].model_copy(update={"code": "quarantined"})

    @staticmethod
    def _safe_stat(path: Path) -> int:
        try:
            return path.stat().st_size
        except OSError:
            return 0

    def _persist_operation(
        self,
        operation_id: str,
        config: Config,
        stats: dict[str, Any],
        duration: int,
        file_records: list[dict[str, Any]],
    ) -> None:
        """Persist a completed operation to SQLite from a worker thread."""
        if self._db is None:
            return
        try:
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
                         incomplete_units, excluded_roots,
                         duration_seconds, config_hash)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
                        json.dumps(stats.get("excluded_roots", []), ensure_ascii=False),
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
                         duplicate_of, suspicious, unit_id, companion_role, unit_primary_path,
                         source_root, would_be_destination)
                    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                    """,
                    [
                        (
                            record["id"],
                            record["operation_id"],
                            record["source_path"],
                            record["dest_path"],
                            record["extracted_date"],
                            record["metadata_source"],
                            record["action"],
                            record["status"],
                            record["error_message"],
                            record["file_size"],
                            record["file_type"],
                            _tags_to_json(record.get("tags", [])),
                            record.get("category"),
                            record.get("camera_model"),
                            record.get("duplicate_type"),
                            record.get("duplicate_similarity"),
                            record.get("duplicate_of"),
                            1 if record.get("suspicious") else 0,
                            record.get("unit_id"),
                            record.get("companion_role"),
                            record.get("unit_primary_path"),
                            record.get("source_root"),
                            record.get("would_be_destination"),
                        )
                        for record in file_records
                    ],
                )
            logger.info("Operation persisted to DB", operation_id=operation_id)
        except Exception as exc:
            logger.error("Failed to persist operation", operation_id=operation_id, error=str(exc))
