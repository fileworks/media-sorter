"""Analysis service — fast directory statistics without full date extraction."""

import asyncio
from collections.abc import Iterator
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.filesystem_service import FileSystemService, categorize_media_type
from app.utils.media_utils import is_media, is_size_included
from app.utils.path_utils import is_excluded_by_pattern

logger = get_logger(__name__)


class AnalysisService:
    """Fast directory analysis: file counts, type breakdown, disk space, duration estimate."""

    def __init__(self, filesystem_service: FileSystemService) -> None:
        self._fs = filesystem_service

    async def analyse(self, config: Config) -> dict[str, Any]:
        """Run analysis in a thread pool to avoid blocking the event loop."""
        return await asyncio.to_thread(self._analyse_sync, config)

    def _analyse_sync(self, config: Config) -> dict[str, Any]:
        source = Path(config.source_directory) if config.source_directory else None
        dest = Path(config.target_directory) if config.target_directory else None
        exclude_patterns = config.exclude_patterns or []
        min_file_size_kb = config.min_file_size_kb
        max_file_size_mb = config.max_file_size_mb
        recursive = config.recursive_scan
        max_depth = config.max_recursion_depth

        if source is None or not source.exists():
            return self._empty_result()

        logger.info("Analysis started", source=str(source))
        now = datetime.now(timezone.utc)
        too_early_ts = datetime(1999, 12, 31).timestamp()
        too_late_ts = datetime(now.year + 1, 12, 31).timestamp()

        total_files = 0
        excluded_files = 0
        total_size_bytes = 0
        by_type: dict[str, int] = {}
        earliest: str | None = None
        latest: str | None = None
        no_date_estimate = 0

        # Walk the directory manually for speed (avoid full list_files overhead),
        # but with the same traversal rules a sort uses (recursion / depth / dot-
        # dir skipping, excluded directories pruned without entering) so the
        # report reflects exactly what would be sorted.
        for file_path in self._iter_candidate_files(source, recursive, max_depth, exclude_patterns):
            if not file_path.is_file():
                continue
            suffix = file_path.suffix.lower()
            if not is_media(file_path):
                continue

            if is_excluded_by_pattern(file_path, source, exclude_patterns):
                excluded_files += 1
                continue

            # One stat per file covers both the size filter and the mtime-based
            # date estimate — this loop is the hot path on large libraries.
            try:
                st = file_path.stat()
                size = st.st_size
                mtime: float | None = st.st_mtime
            except OSError:
                size = 0
                mtime = None

            if not is_size_included(size, min_file_size_kb, max_file_size_mb):
                excluded_files += 1
                continue

            total_files += 1
            total_size_bytes += size

            # Type categorization
            cat = categorize_media_type(suffix)
            by_type[cat] = by_type.get(cat, 0) + 1

            # Date estimation via mtime
            try:
                if mtime is None or mtime < too_early_ts or mtime > too_late_ts:
                    no_date_estimate += 1
                else:
                    mtime_dt_str = datetime.fromtimestamp(mtime).date().isoformat()
                    if earliest is None or mtime_dt_str < earliest:
                        earliest = mtime_dt_str
                    if latest is None or mtime_dt_str > latest:
                        latest = mtime_dt_str
            except (OSError, ValueError):
                no_date_estimate += 1

        # Disk space
        mode = "copy" if config.copy_instead_of_move else "move"
        free, known = self._dest_free_space(dest)
        dest_free = free if known else 0
        if mode == "copy":
            # Unknown free space must not block the user, but is flagged via
            # free_space_known so the UI can show an honest "unknown" state.
            sufficient = (
                free >= int(total_size_bytes * 1.05) if known and free is not None else True
            )
        else:
            sufficient = True  # move frees source space

        # Warnings
        warnings = []
        if no_date_estimate > 0:
            warnings.append(f"{no_date_estimate} file(s) may have suspicious or missing dates")

        logger.info(
            "Analysis complete",
            total_files=total_files,
            by_type=by_type,
            excluded=excluded_files,
        )
        return {
            "total_files": total_files,
            "total_size_bytes": total_size_bytes,
            "by_type": by_type,
            "date_range": {
                "earliest": earliest,
                "latest": latest,
                "no_date_estimate": no_date_estimate,
            },
            "disk_space": {
                "source_size_bytes": total_size_bytes,
                "destination_free_bytes": dest_free,
                "sufficient": sufficient,
                "mode": mode,
                "free_space_known": known,
            },
            "excluded_files": excluded_files,
            "estimated_duration_seconds": round(total_files * 0.1),
            "warnings": warnings,
        }

    async def disk_space_check(self, config: Config) -> dict[str, Any]:
        """Real-time disk space check for the config panel.

        Offloaded to a thread because summing the source tree size is a full
        recursive walk — on a large library that would otherwise block the
        event loop (this endpoint is polled as the user edits the config).
        """
        return await asyncio.to_thread(self._disk_space_check_sync, config)

    def _disk_space_check_sync(self, config: Config) -> dict[str, Any]:
        source = Path(config.source_directory) if config.source_directory else None
        dest = Path(config.target_directory) if config.target_directory else None
        mode = "copy" if config.copy_instead_of_move else "move"

        # Sum only the media files a sort would act on — same inclusion *and*
        # traversal rules as ``_analyse_sync`` — so this check and the analysis
        # report agree, and both match what the sort would actually move/copy.
        source_size = (
            self._included_media_size(
                source,
                config.recursive_scan,
                config.max_recursion_depth,
                config.exclude_patterns or [],
                config.min_file_size_kb,
                config.max_file_size_mb,
            )
            if source and source.exists()
            else 0
        )
        free, known = self._dest_free_space(dest)
        dest_free = free if known else 0

        if mode == "copy":
            # Don't block the user when free space is unknown; surface the
            # uncertainty via free_space_known instead of a false "not enough".
            sufficient = free >= int(source_size * 1.05) if known and free is not None else True
        else:
            sufficient = True  # move frees source space

        return {
            "source_size_bytes": source_size,
            "destination_free_bytes": dest_free,
            "sufficient": sufficient,
            "mode": mode,
            "free_space_known": known,
        }

    def _dest_free_space(self, dest: Path | None) -> tuple[int | None, bool]:
        """Resolve free space at *dest*, degrading to unknown rather than crashing.

        Returns ``(free_bytes, known)``. ``known`` is ``False`` — and
        ``free_bytes`` is ``None`` — when there is no destination, the path is
        inaccessible (``Path.exists()`` can raise ``PermissionError`` under macOS
        TCC), or the volume's free space cannot be read. ``FileSystemService.
        get_available_space`` already walks up to the nearest existing ancestor,
        so a not-yet-created nested target still reports its volume's free space.
        """
        if dest is None:
            return None, False
        try:
            dest.exists()  # probe accessibility; may raise under TCC denial
        except OSError as exc:
            logger.warning(
                "Destination path inaccessible for free-space check",
                path=str(dest),
                error=str(exc),
            )
            return None, False
        free = self._fs.get_available_space(dest)
        return free, free is not None

    def _included_media_size(
        self,
        source: Path,
        recursive: bool,
        max_depth: int | None,
        exclude_patterns: list[str],
        min_file_size_kb: int | None,
        max_file_size_mb: int | None,
    ) -> int:
        """Total bytes of the media files a sort would actually act on.

        Mirrors both the traversal rules (recursion / depth / dot-dir skipping)
        and the inclusion rules (media extensions only, honoring exclude patterns
        and size filters) of ``_analyse_sync`` so the disk-space check and the
        analysis report never report a different source size.
        """
        total = 0
        for file_path in self._iter_candidate_files(source, recursive, max_depth, exclude_patterns):
            if not file_path.is_file() or not is_media(file_path):
                continue
            if is_excluded_by_pattern(file_path, source, exclude_patterns):
                continue
            try:
                size = file_path.stat().st_size
            except OSError:
                continue
            if not is_size_included(size, min_file_size_kb, max_file_size_mb):
                continue
            total += size
        return total

    @staticmethod
    def _iter_candidate_files(
        source: Path,
        recursive: bool,
        max_depth: int | None,
        exclude_patterns: list[str] | None = None,
    ) -> Iterator[Path]:
        """Yield files under *source* using the same traversal a sort uses.

        Matches ``FileSystemService._walk``: descends into a subdirectory only
        when ``recursive`` is set, the directory is not a dot-folder, the depth
        limit (``max_depth``; ``None`` = unlimited) allows it, and the directory
        is not excluded by pattern — excluded trees are pruned without entering
        them (exclusion must not cost I/O), so their contents are neither walked
        nor counted, matching the sort's skipped count. Files are yielded raw;
        callers apply the ``is_file`` / media / size filters.
        """
        patterns = exclude_patterns or []
        stack: list[tuple[Path, int]] = [(source, 0)]
        while stack:
            current, depth = stack.pop()
            try:
                entries = list(current.iterdir())
            except (OSError, PermissionError):
                continue
            for entry in entries:
                if entry.is_dir():
                    if (
                        recursive
                        and not entry.name.startswith(".")
                        and (max_depth is None or depth < max_depth)
                        and not (patterns and is_excluded_by_pattern(entry, source, patterns))
                    ):
                        stack.append((entry, depth + 1))
                else:
                    yield entry

    @staticmethod
    def _empty_result() -> dict[str, Any]:
        return {
            "total_files": 0,
            "total_size_bytes": 0,
            "by_type": {},
            "date_range": {"earliest": None, "latest": None, "no_date_estimate": 0},
            "disk_space": {
                "source_size_bytes": 0,
                "destination_free_bytes": 0,
                "sufficient": True,
                "mode": "copy",
                # No source ⇒ no analysis ran ⇒ free space was never read.
                "free_space_known": False,
            },
            "excluded_files": 0,
            "estimated_duration_seconds": 0,
            "warnings": [],
        }
