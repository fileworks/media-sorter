"""Index the configured roots so duplicate review has something to review.

The catalog is what `GET /api/review/groups` reads. Without a generation in it
the duplicate workbench is empty no matter how many duplicates the dry run
found — the plan hashes files in memory, the catalog is a separate persistent
index, and nothing was populating it outside the test suite.

Indexing is folded into the dry run rather than exposed as a step the user has
to know about: "preview the changes" is already the moment the whole library is
being read, and asking somebody to press *scan* and then *preview* is asking
them to understand why the two exist.

The pass is advisory. A failure here costs the richer per-group evidence in
Review, never the plan itself, so it is logged and swallowed rather than
allowed to fail a dry run that otherwise succeeded.
"""

from __future__ import annotations

import hashlib
from collections.abc import Callable
from pathlib import Path

import structlog

from app.core.library_profiles import CatalogPlacement, LibraryProfile
from app.core.library_validation import ValidatedLibraryProfile
from app.services.catalog import MediaCatalog
from app.services.catalog_location import open_catalog
from app.services.discovery import DiscoveryStats, TraversalRules, discover_many

logger = structlog.get_logger(__name__)


def index_library_roots(
    library: ValidatedLibraryProfile | LibraryProfile | None,
    *,
    data_dir: Path,
    recursive: bool = True,
    max_depth: int | None = None,
    exclude_patterns: tuple[str, ...] = (),
    cancel: Callable[[], bool] | None = None,
) -> dict[str, int]:
    """Walk every input and reference root into the catalog.

    Destinations are excluded: the index exists to answer "which of the files
    I am about to organize are copies of each other", and the destination is
    the answer's other half, indexed by the sort itself.

    Returns the file count per root, for logging and for the caller to report.
    """
    if library is None:
        return {}

    # Keep the indexing seam compatible while callers migrate to the validated
    # profile contract. PreviewService on the first baseline commit still
    # supplies the persisted LibraryProfile; preserve its existing advisory
    # path until the next commit moves that caller to validation.
    if isinstance(library, LibraryProfile):
        return _index_legacy_profile(
            library,
            data_dir=data_dir,
            recursive=recursive,
            max_depth=max_depth,
            exclude_patterns=exclude_patterns,
            cancel=cancel,
        )

    indexable = [root for root in (*library.inputs, *library.references) if root.canonical_path]
    if not indexable:
        return {}

    placement = library.profile.catalog or CatalogPlacement()
    if placement.mode != "application_data":
        placement = CatalogPlacement()

    targets = [
        (
            root.root.root_id,
            root.canonical_path,
            TraversalRules(
                recursive=recursive,
                max_depth=max_depth,
                exclusions=root.exclusions,
                exclude_patterns=tuple(exclude_patterns),
            ),
        )
        for root in indexable
    ]

    try:
        with open_catalog(placement, data_dir=data_dir) as catalog:
            # A generation is keyed to a root row, so the root has to exist
            # before the walk starts — otherwise the first insert fails on a
            # foreign key and the whole pass is lost. Registration is
            # idempotent, so re-previewing the same library is free.
            for root in indexable:
                catalog.register_root(
                    root.root.root_id,
                    root.canonical_path,
                    role=root.root.role,
                    volume_id=root.identity.volume_id,
                )
            paths = {root.root.root_id: root.canonical_path for root in indexable}
            hashed = 0
            skipped = 0

            def derive(root_id: str, stats: DiscoveryStats) -> None:
                nonlocal hashed, skipped
                computed, unread = _hash_root_files(
                    catalog, root_id, paths[root_id], stats, cancel=cancel
                )
                hashed += computed
                skipped += unread

            results = discover_many(catalog, targets, cancel=cancel, derive=derive)
    except Exception as error:  # pragma: no cover - defensive, see module docstring
        logger.warning(
            "catalog.indexing_failed",
            error=str(error),
            roots=[root_id for root_id, _, _ in targets],
        )
        return {}

    counts = {root_id: stats.files for root_id, stats in results.items()}
    logger.info("catalog.indexed", roots=counts, hashed=hashed, skipped=skipped)
    return counts


def _index_legacy_profile(
    profile: LibraryProfile,
    *,
    data_dir: Path,
    recursive: bool,
    max_depth: int | None,
    exclude_patterns: tuple[str, ...],
    cancel: Callable[[], bool] | None,
) -> dict[str, int]:
    """Retain the pre-validation indexing seam for the first baseline commit."""
    indexable = [
        root for root in profile.roots if root.role in {"input", "reference"} and root.path
    ]
    if not indexable:
        return {}

    placement = profile.catalog or CatalogPlacement()
    if placement.mode != "application_data":
        placement = CatalogPlacement()

    targets = [
        (
            root.root_id,
            Path(root.path),
            TraversalRules(
                recursive=recursive,
                max_depth=max_depth,
                exclusions=tuple(Path(item) for item in root.exclusions),
                exclude_patterns=tuple(exclude_patterns),
            ),
        )
        for root in indexable
    ]

    try:
        with open_catalog(placement, data_dir=data_dir) as catalog:
            for root in indexable:
                catalog.register_root(
                    root.root_id,
                    Path(root.path),
                    role=root.role,
                    volume_id=root.identity.volume_id if root.identity else None,
                )
            paths = {root.root_id: Path(root.path) for root in indexable}
            hashed = 0
            skipped = 0

            def derive(root_id: str, stats: DiscoveryStats) -> None:
                nonlocal hashed, skipped
                computed, unread = _hash_root_files(
                    catalog, root_id, paths[root_id], stats, cancel=cancel
                )
                hashed += computed
                skipped += unread

            results = discover_many(catalog, targets, cancel=cancel, derive=derive)
    except Exception as error:  # pragma: no cover - defensive, see module docstring
        logger.warning(
            "catalog.indexing_failed",
            error=str(error),
            roots=[root_id for root_id, _, _ in targets],
        )
        return {}

    counts = {root_id: stats.files for root_id, stats in results.items()}
    logger.info("catalog.indexed", roots=counts, hashed=hashed, skipped=skipped)
    return counts


def _hash_root_files(
    catalog: MediaCatalog,
    root_id: str,
    root_path: Path,
    stats: DiscoveryStats,
    *,
    cancel: Callable[[], bool] | None = None,
) -> tuple[int, int]:
    """Give every indexed file a content hash, skipping ones that already have one.

    Exact-duplicate grouping is a hash join, so a file without a hash is a file
    the duplicate workbench cannot see. The skip is not an optimisation detail:
    a stored hash is only reused when the catalog's fingerprint still proves it
    describes the same bytes, so re-previewing an unchanged library costs
    nothing and a changed file is always re-read.

    A file that cannot be read is recorded on *stats* rather than swallowed. The
    walk saw it, so nothing else would ever say it is missing from the index —
    and a generation that hashed only some of its files has not learned what a
    `complete` one claims to have learned.

    Returns ``(hashed, skipped)`` — the second number is why the generation
    may be `partial`, so it is reported rather than inferred from a log line.
    """
    computed = 0
    skipped = 0
    for record in catalog.iter_files(root_id):
        if cancel is not None and cancel():
            stats.cancelled = True
            return computed, skipped
        if catalog.hash_for(record) is not None:
            continue
        path = root_path / record.relative_path
        try:
            digest = _sha256_of(path)
        except OSError as error:
            logger.debug("catalog.hash_skipped", path=str(path), error=str(error))
            stats.issues.append((str(path), "hash_unreadable"))
            skipped += 1
            continue
        catalog.store_hash(record, digest)
        computed += 1
    return computed, skipped


def _sha256_of(path: Path, *, block_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(block_size), b""):
            digest.update(block)
    return digest.hexdigest()
