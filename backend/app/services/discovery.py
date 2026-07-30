"""Streaming discovery: a traversal that never holds the library in memory.

The producer yields observations as it finds them and writes them to the catalog
in bounded batches, so peak memory is one batch — not one library. Cancellation
is checked at every directory and every batch boundary, and a run that stops
early finishes its generation as ``cancelled`` or ``partial``, which is what
stops the catalog from pruning rows it merely did not reach.
"""

from __future__ import annotations

import fnmatch
import os
from collections.abc import Callable, Iterator, Sequence
from dataclasses import dataclass, field
from pathlib import Path

from app.core.logging_config import get_logger
from app.core.media_units import CompanionHandling, bind_media_units
from app.services.catalog import MediaCatalog, ObservedFile, bounded_sample_sha256
from app.services.pipeline import batched
from app.utils.media_utils import is_media

logger = get_logger(__name__)

DEFAULT_BATCH_SIZE = 500


@dataclass(frozen=True)
class TraversalRules:
    """Every rule a profile's root can impose on a walk."""

    recursive: bool = True
    max_depth: int | None = None
    #: Canonical subtrees that are never entered, relative or absolute.
    exclusions: tuple[Path, ...] = ()
    exclude_patterns: tuple[str, ...] = ()
    min_file_size_bytes: int | None = None
    max_file_size_bytes: int | None = None
    follow_symlinks: bool = False
    companion_handling: CompanionHandling = "keep_with_primary"
    case_sensitive_stems: bool = False

    def excludes_directory(self, root: Path, directory: Path, depth: int) -> bool:
        if not self.recursive and depth > 0:
            return True
        if self.max_depth is not None and depth > self.max_depth:
            return True
        if any(_is_within(directory, exclusion, root) for exclusion in self.exclusions):
            return True
        return any(fnmatch.fnmatch(directory.name, pattern) for pattern in self.exclude_patterns)

    def excludes_file(self, path: Path, size_bytes: int) -> bool:
        if any(fnmatch.fnmatch(path.name, pattern) for pattern in self.exclude_patterns):
            return True
        if self.min_file_size_bytes is not None and size_bytes < self.min_file_size_bytes:
            return True
        return self.max_file_size_bytes is not None and size_bytes > self.max_file_size_bytes


def _is_within(candidate: Path, exclusion: Path, root: Path) -> bool:
    target = exclusion if exclusion.is_absolute() else root / exclusion
    try:
        candidate.relative_to(target)
    except ValueError:
        return False
    return True


@dataclass
class DiscoveryStats:
    """What the walk saw, including everything it could not."""

    directories: int = 0
    files: int = 0
    excluded: int = 0
    bytes_seen: int = 0
    eligible_media: int = 0
    companions: int = 0
    unmatched_companions: list[tuple[str, str]] = field(default_factory=list)
    cancelled: bool = False
    #: Paths that could not be read. Their presence is what makes a scan
    #: *partial* — a library with an unreadable subtree was never fully seen.
    issues: list[tuple[str, str]] = field(default_factory=list)

    @property
    def complete(self) -> bool:
        return not self.cancelled and not self.issues

    @property
    def outcome(self) -> str:
        if self.cancelled:
            return "cancelled"
        return "complete" if not self.issues else "partial"


def walk(
    root: Path,
    rules: TraversalRules,
    stats: DiscoveryStats,
    *,
    cancel: Callable[[], bool] | None = None,
) -> Iterator[ObservedFile]:
    """Yield observations depth-first, never building a list of the tree.

    A directory that cannot be read is recorded as an issue and skipped: one
    locked folder must not end a scan of a million files, but it must also not
    let the result be reported as complete.
    """
    stack: list[tuple[Path, int]] = [(root, 0)]
    while stack:
        if cancel is not None and cancel():
            stats.cancelled = True
            return
        current, depth = stack.pop()
        stats.directories += 1
        try:
            entries = sorted(current.iterdir())
        except OSError as exc:
            stats.issues.append((str(current), type(exc).__name__))
            continue

        observed_entries: list[tuple[Path, os.stat_result]] = []
        for entry in entries:
            try:
                if entry.is_symlink() and not rules.follow_symlinks:
                    stats.excluded += 1
                    continue
                if entry.is_dir():
                    if not rules.excludes_directory(root, entry, depth + 1):
                        stack.append((entry, depth + 1))
                    else:
                        stats.excluded += 1
                    continue
                observed = entry.stat()
            except OSError as exc:
                stats.issues.append((str(entry), type(exc).__name__))
                continue

            if rules.excludes_file(entry, observed.st_size):
                stats.excluded += 1
                continue
            stats.files += 1
            stats.bytes_seen += observed.st_size
            if is_media(entry):
                stats.eligible_media += 1
            observed_entries.append((entry, observed))

        paths = [path for path, _stat in observed_entries]
        units, unmatched = bind_media_units(
            paths,
            root,
            handling=rules.companion_handling,
            case_sensitive=rules.case_sensitive_stems,
        )
        membership = {member.path: (unit, member) for unit in units for member in unit.members}
        stats.companions += sum(len(unit.companions) for unit in units)
        stats.unmatched_companions.extend(
            (str(item.path.relative_to(root)), item.companion_role) for item in unmatched
        )
        for entry, observed in observed_entries:
            if cancel is not None and cancel():
                stats.cancelled = True
                return
            unit_member = membership.get(entry)
            unit = unit_member[0] if unit_member is not None else None
            member = unit_member[1] if unit_member is not None else None
            yield ObservedFile(
                relative_path=str(entry.relative_to(root)),
                size_bytes=observed.st_size,
                mtime_ns=observed.st_mtime_ns,
                ctime_ns=getattr(observed, "st_ctime_ns", None),
                file_identity=str(observed.st_ino) or None,
                sample_sha256=bounded_sample_sha256(entry) if os.name == "nt" else None,
                unit_id=None if unit is None else unit.unit_id,
                companion_role=None if member is None else member.companion_role,
                unit_primary=False if member is None else member.is_primary,
                primary_relative_path=(
                    None if unit is None else str(unit.primary.relative_to(root))
                ),
            )


def discover_into_catalog(
    catalog: MediaCatalog,
    root_id: str,
    root: Path,
    rules: TraversalRules | None = None,
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    cancel: Callable[[], bool] | None = None,
    on_batch: Callable[[int, DiscoveryStats], None] | None = None,
) -> DiscoveryStats:
    """Walk one root into the catalog in bounded, committed batches.

    Each batch is one transaction. A crash costs the current batch and nothing
    else, and the generation's outcome decides whether the catalog is allowed to
    treat unseen rows as missing — so an interrupted scan can never make files
    disappear from the index.
    """
    rules = rules or TraversalRules()
    stats = DiscoveryStats()
    generation = catalog.begin_generation(root_id)
    written = 0
    try:
        for batch in batched(walk(root, rules, stats, cancel=cancel), batch_size):
            catalog.observe(root_id, generation, batch)
            written += len(batch)
            if on_batch is not None:
                on_batch(written, stats)
        for path, error_class in stats.issues:
            catalog.record_issue(
                root_id,
                generation,
                path=path,
                error_class=error_class,
                message="path could not be read during discovery",
            )
    finally:
        catalog.finish_generation(generation, stats.outcome)  # type: ignore[arg-type]
    logger.info(
        "Discovery finished",
        root_id=root_id,
        files=stats.files,
        issues=len(stats.issues),
        outcome=stats.outcome,
    )
    return stats


def discover_many(
    catalog: MediaCatalog,
    roots: Sequence[tuple[str, Path, TraversalRules]],
    *,
    batch_size: int = DEFAULT_BATCH_SIZE,
    cancel: Callable[[], bool] | None = None,
) -> dict[str, DiscoveryStats]:
    """Walk several roots, one after another, stopping cleanly on cancellation."""
    results: dict[str, DiscoveryStats] = {}
    for root_id, path, rules in roots:
        if cancel is not None and cancel():
            break
        results[root_id] = discover_into_catalog(
            catalog,
            root_id,
            path,
            rules,
            batch_size=batch_size,
            cancel=cancel,
        )
    return results
