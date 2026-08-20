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
import os
from collections import deque
from collections.abc import Callable
from concurrent.futures import Future, ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

import structlog
from pydantic import JsonValue

from app.core.library_profiles import CatalogPlacement, LibraryProfile
from app.core.library_validation import ValidatedLibraryProfile
from app.services.catalog import FileRecord, MediaCatalog
from app.services.catalog_duplicates import IMAGE_SIGNATURE_KIND, VIDEO_SIGNATURE_KIND
from app.services.catalog_location import open_catalog
from app.services.discovery import DiscoveryStats, TraversalRules, discover_many
from app.services.signature_extraction import MediaSignature, extract_signature
from app.utils.media_utils import get_file_type, is_video

logger = structlog.get_logger(__name__)

#: Readers and decoders for the derive pass. Decoding is the expensive half
#: — measured at roughly 7.3 ms per megapixel — and both Pillow and hashlib
#: release the GIL while they work, so threads buy real parallelism here.
#: Capped because the pass runs beside a UI, not instead of it.
DERIVE_WORKERS = min(8, max(1, (os.cpu_count() or 2)))

#: Reports ``(examined, total)`` as the derive pass works through a root.
#: The total is the count the walk just finished producing, so it is known
#: rather than estimated — which is what lets a caller show an honest ETA
#: instead of an indeterminate bar (I-10, `TaskProgress.total_known`).
DeriveProgress = Callable[[int, int], None]


def index_library_roots(
    library: ValidatedLibraryProfile | LibraryProfile | None,
    *,
    data_dir: Path,
    recursive: bool = True,
    max_depth: int | None = None,
    exclude_patterns: tuple[str, ...] = (),
    cancel: Callable[[], bool] | None = None,
    on_progress: DeriveProgress | None = None,
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
            on_progress=on_progress,
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
                computed, unread = _derive_root_facts(
                    catalog,
                    root_id,
                    paths[root_id],
                    stats,
                    cancel=cancel,
                    on_progress=on_progress,
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
    on_progress: DeriveProgress | None = None,
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
                computed, unread = _derive_root_facts(
                    catalog,
                    root_id,
                    paths[root_id],
                    stats,
                    cancel=cancel,
                    on_progress=on_progress,
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


def _derive_root_facts(
    catalog: MediaCatalog,
    root_id: str,
    root_path: Path,
    stats: DiscoveryStats,
    *,
    cancel: Callable[[], bool] | None = None,
    workers: int | None = None,
    on_progress: DeriveProgress | None = None,
) -> tuple[int, int]:
    """Give every indexed file a content hash and a perceptual signature.

    Exact-duplicate grouping is a hash join, so a file without a hash is a file
    the duplicate workbench cannot see. The skip is not an optimisation detail:
    a stored fact is only reused when the catalog's fingerprint still proves it
    describes the same bytes, so re-previewing an unchanged library costs
    nothing and a changed file is always re-read.

    A file that cannot be read is recorded on *stats* rather than swallowed. The
    walk saw it, so nothing else would ever say it is missing from the index —
    and a generation that derived only some of its files has not learned what a
    `complete` one claims to have learned.

    Reading and decoding happen on a pool; **every catalog read and write stays
    on this thread**, because the connection is single-threaded and because a
    worker that cannot touch the database cannot corrupt it. Submission is
    bounded by a window, so memory stays flat over a library of any size.

    Returns ``(hashed, skipped)`` — the second number is why the generation may
    be `partial`, so it is reported rather than inferred from a log line.
    """
    computed = 0
    skipped = 0
    examined = 0
    total = stats.files
    pending: deque[Future[_Derived]] = deque()

    def write_one() -> None:
        nonlocal computed, skipped
        result = pending.popleft().result()
        if result.unreadable is not None:
            logger.debug("catalog.hash_skipped", path=str(result.path), error=result.unreadable)
            stats.issues.append((str(result.path), "hash_unreadable"))
            skipped += 1
            return
        if result.digest is not None:
            catalog.store_hash(result.record, result.digest)
            computed += 1
        if result.signature is not None:
            _write_media_signature(catalog, result.record, result.path, result.signature)

    worker_count = DERIVE_WORKERS if workers is None else max(1, workers)
    window = worker_count * 4
    with ThreadPoolExecutor(max_workers=worker_count, thread_name_prefix="derive") as pool:
        try:
            for record in catalog.iter_files(root_id):
                if cancel is not None and cancel():
                    stats.cancelled = True
                    break
                path = root_path / record.relative_path
                want_hash = catalog.hash_for(record) is None
                want_signature = catalog.media_facts_for(record) is None
                examined += 1
                if on_progress is not None:
                    on_progress(examined, total)
                if not want_hash and not want_signature:
                    continue
                pending.append(
                    pool.submit(
                        _compute_facts,
                        record,
                        path,
                        want_hash=want_hash,
                        want_signature=want_signature,
                    )
                )
                while len(pending) >= window:
                    write_one()
        finally:
            if stats.cancelled:
                # Whatever has not started need not start; the rest is already
                # paid for, so its result is still worth storing.
                for future in pending:
                    future.cancel()
            while pending:
                if pending[0].cancelled():
                    pending.popleft()
                    continue
                write_one()
    return computed, skipped


@dataclass(frozen=True)
class _Derived:
    """What one worker computed. Nothing here has touched the catalog."""

    record: FileRecord
    path: Path
    digest: str | None
    unreadable: str | None
    signature: MediaSignature | None


def _compute_facts(
    record: FileRecord, path: Path, *, want_hash: bool, want_signature: bool
) -> _Derived:
    """The pure half: read bytes, hash them, decode a signature. No database."""
    digest: str | None = None
    if want_hash:
        try:
            digest = _sha256_of(path)
        except OSError as error:
            return _Derived(record, path, None, str(error), None)
    signature = extract_signature(path) if want_signature else None
    return _Derived(record, path, digest, None, signature)


def _write_media_signature(
    catalog: MediaCatalog, record: FileRecord, path: Path, signature: MediaSignature
) -> None:
    """Record what a perceptual pass saw, so review has groups to show.

    The media-facts row is written for every file, including one where nothing
    could be read: its presence is what says "this file has been looked at", so
    a second pass is a cache hit rather than a re-decode. An unknown fact is
    stored as NULL and never as 0 (I-10).

    A file that cannot be *decoded* is not a file that cannot be *read*: it
    yields unknown facts, not an issue, and never downgrades the generation.
    """
    catalog.store_media_facts(
        record,
        kind=get_file_type(path),
        captured_at=signature.captured_at.value,
        camera_model=signature.camera_model.value,
        width=signature.width.value,
        height=signature.height.value,
        duration_seconds=signature.duration_seconds.value,
    )
    if signature.phash.known:
        # A video's signature is a frame series, not a single image hash: it has
        # a different width and needs a different distance threshold, so it is
        # stored under its own kind rather than mixed in with the images.
        catalog.store_signature(
            record,
            VIDEO_SIGNATURE_KIND if is_video(path) else IMAGE_SIGNATURE_KIND,
            str(signature.phash.value),
            mean_rgb=_mean_rgb_text(signature.mean_rgb.value),
        )


def _mean_rgb_text(mean: JsonValue) -> str | None:
    """The comma-joined form `dedup_index` already stores, or None if unknown."""
    if not isinstance(mean, list):
        return None
    return ",".join(
        f"{float(channel):.3f}" for channel in mean if isinstance(channel, (int, float))
    )


def _sha256_of(path: Path, *, block_size: int = 1024 * 1024) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(block_size), b""):
            digest.update(block)
    return digest.hexdigest()
