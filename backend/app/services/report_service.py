"""Report service — retrieve and export operation reports.

GET /api/reports/{operation_id} response shape:

{
  "operation_id": "sort_abc123",
  "execution_date": "2026-05-24T14:30:00",
  "source_path": "/home/user/photos",
  "dest_path": "/home/user/sorted",
  "duration_seconds": 42,
  "summary": {
    "total": 100,
    "sorted": 85,
    "failed": 3,
    "duplicates": 5,
    "future_dates": 2,
    "unknown_dates": 5,
    "corrupted": 0
  },
  "statistics": {
    "files_per_year": {"2024": 85},
    "files_per_type": {"jpeg": 70, "mp4": 15},
    "largest_files": [...],
    "camera_models": {"Unknown": 85}
  },
  "files": [
    {
      "id": "uuid",
      "source_path": "/...",
      "dest_path": "/...",
      "extracted_date": "2024-01-15",
      "metadata_source": "exif",
      "action": "copy",
      "status": "success",
      "error_message": null,
      "file_size": 2048576,
      "file_type": ".jpg",
      "tags": ["landscape"],
      "category": "nature",
      "camera_model": null,
      "duplicate_type": null,
      "duplicate_similarity": null,
      "duplicate_of": null,
      "suspicious": false
    },
    ...
  ]
}
"""

import asyncio
import csv
import io
import json
from typing import Any, Literal

from app.core.database import DatabaseManager
from app.core.exceptions import OperationNotFoundError
from app.core.serializers import serialize_file_operation
from app.services.filesystem_service import categorize_media_type


class ReportService:
    def __init__(self, db_manager: DatabaseManager) -> None:
        self._db = db_manager

    # ------------------------------------------------------------------ #
    # Single operation report                                               #
    # ------------------------------------------------------------------ #

    def _get_report_sync(self, operation_id: str) -> dict[str, Any]:
        """Synchronous core for get_report — must be called via asyncio.to_thread."""
        with self._db._connect() as conn:
            row = conn.execute("SELECT * FROM operations WHERE id = ?", (operation_id,)).fetchone()
            if row is None:
                raise OperationNotFoundError(operation_id)
            op = dict(row)
            file_rows = conn.execute(
                "SELECT * FROM file_operations WHERE operation_id = ? ORDER BY timestamp",
                (operation_id,),
            ).fetchall()

        # serialize_file_operation centralises the tags-string → list and
        # suspicious 0/1 → bool coercions so any reader is consistent.
        files: list[dict[str, Any]] = [serialize_file_operation(dict(r)) for r in file_rows]

        # Compute statistics
        stats_files_per_year: dict[str, int] = {}
        stats_files_per_type: dict[str, int] = {}
        stats_camera_models: dict[str, int] = {}
        largest_files = []

        for f in files:
            # files_per_year
            ed = f.get("extracted_date")
            if ed:
                try:
                    year = str(ed)[:4]
                    stats_files_per_year[year] = stats_files_per_year.get(year, 0) + 1
                except (ValueError, TypeError):
                    pass

            # files_per_type
            ft = f.get("file_type") or ""
            cat = categorize_media_type(ft)
            stats_files_per_type[cat] = stats_files_per_type.get(cat, 0) + 1

            # camera_models
            cm = f.get("camera_model") or "Unknown"
            stats_camera_models[cm] = stats_camera_models.get(cm, 0) + 1

            # largest files tracking
            fs = f.get("file_size") or 0
            if fs and f.get("dest_path"):
                largest_files.append({"path": f["dest_path"], "size_bytes": fs})

        largest_files.sort(key=lambda x: x["size_bytes"], reverse=True)

        statistics = {
            "files_per_year": stats_files_per_year,
            "files_per_type": stats_files_per_type,
            "largest_files": largest_files[:10],
            "camera_models": stats_camera_models,
        }

        return {
            "operation_id": op["id"],
            "execution_date": op["execution_date"],
            "source_path": op["source_path"],
            "dest_path": op["dest_path"],
            "duration_seconds": op.get("duration_seconds"),
            "summary": {
                "total": op["total_files"],
                "sorted": op["files_sorted"],
                "failed": op["files_failed"],
                "duplicates": op["duplicates_found"],
                "future_dates": op.get("future_dates", 0) or 0,
                "unknown_dates": op.get("unknown_dates", 0) or 0,
                "corrupted": op.get("corrupted_files", 0) or 0,
                "junk": op.get("junk_files", 0) or 0,
                "already_in_destination": op.get("already_in_destination", 0) or 0,
            },
            "statistics": statistics,
            "files": files,
        }

    async def get_report(self, operation_id: str) -> dict[str, Any]:
        """Return full operation report.

        Raises:
            OperationNotFoundError: if *operation_id* does not exist.
        """
        return await asyncio.to_thread(self._get_report_sync, operation_id)

    # ------------------------------------------------------------------ #
    # Export                                                                #
    # ------------------------------------------------------------------ #

    async def export(
        self,
        operation_id: str,
        fmt: Literal["csv", "json"],
    ) -> tuple[str, str, str]:
        """Export report as CSV or JSON.

        Raises:
            OperationNotFoundError: if *operation_id* does not exist.
        """
        # Use the sync core directly (not self.get_report) to avoid a nested
        # thread hop — to_thread already runs us in a thread here.
        report = await asyncio.to_thread(self._get_report_sync, operation_id)
        files = report.get("files", [])

        if fmt == "json":
            content = json.dumps(report, indent=2, default=str)
            return content, "application/json", f"report_{operation_id}.json"

        buf = io.StringIO()
        if files:
            # Mirror the JSON-report column set so CSV exports are not less
            # rich than what the UI shows.
            fieldnames = [
                "source_path",
                "dest_path",
                "extracted_date",
                "metadata_source",
                "action",
                "status",
                "error_message",
                "file_size",
                "file_type",
                "tags",
                "category",
                "camera_model",
                "duplicate_type",
                "duplicate_similarity",
                "duplicate_of",
                "suspicious",
            ]
            writer = csv.DictWriter(buf, fieldnames=fieldnames, extrasaction="ignore")
            writer.writeheader()
            for f in files:
                row = {k: f.get(k, "") for k in fieldnames}
                if isinstance(row.get("tags"), list):
                    row["tags"] = ",".join(row["tags"])
                writer.writerow(row)
        return buf.getvalue(), "text/csv", f"report_{operation_id}.csv"

    # ------------------------------------------------------------------ #
    # List operations (History panel)                                       #
    # ------------------------------------------------------------------ #

    def _list_operations_sync(self, limit: int, offset: int) -> dict[str, Any]:
        """Synchronous core for list_operations — must be called via asyncio.to_thread."""
        with self._db._connect() as conn:
            rows = conn.execute(
                """
                SELECT id, execution_date, source_path, dest_path,
                       total_files, files_sorted, files_failed,
                       duplicates_found, duration_seconds
                FROM operations
                ORDER BY execution_date DESC
                LIMIT ? OFFSET ?
                """,
                (limit, offset),
            ).fetchall()
            total = conn.execute("SELECT COUNT(*) FROM operations").fetchone()[0]

        return {
            "operations": [dict(r) for r in rows],
            "total": total,
            "limit": limit,
            "offset": offset,
        }

    async def list_operations(self, limit: int = 20, offset: int = 0) -> dict[str, Any]:
        """Return paginated list of past sorting operations, newest first."""
        return await asyncio.to_thread(self._list_operations_sync, limit, offset)

    def _clear_all_history_sync(self) -> dict[str, Any]:
        """Synchronous core for clear_all_history — must be called via asyncio.to_thread."""
        with self._db._connect() as conn:
            conn.execute("DELETE FROM file_operations")
            conn.execute("DELETE FROM operations")
        return {"cleared": True}

    async def clear_all_history(self) -> dict[str, Any]:
        """Delete every operation and its file records from the database."""
        return await asyncio.to_thread(self._clear_all_history_sync)
