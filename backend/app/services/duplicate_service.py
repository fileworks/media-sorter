"""Duplicate detection service — hash-based and perceptual."""

from __future__ import annotations

import asyncio
import hashlib
import math
from collections.abc import Callable
from dataclasses import dataclass, field
from pathlib import Path
from typing import TYPE_CHECKING, Any, TypeVar

from app.core.config import Config
from app.core.logging_config import get_logger
from app.services.filesystem_service import image_dimensions, open_image
from app.utils.ffmpeg_utils import extract_frame, probe_duration, sample_fractions
from app.utils.media_utils import is_image, is_video

if TYPE_CHECKING:
    from app.background_tasks.task_manager import Task

logger = get_logger(__name__)

# Minimum Euclidean distance between mean RGB values (0-255 each channel)
# below which we allow the perceptual hash comparison to proceed.
# Two images with very different average colors (e.g. all-black vs all-red)
# cannot be perceptual duplicates regardless of what the hash says.
_COLOR_DISTANCE_THRESHOLD = 40.0

# Number of frames sampled per video for perceptual comparison.
# More frames = better accuracy but higher compute cost.
_VIDEO_SAMPLE_COUNT = 5

# Hash size for perceptual hashing; 16 → 256-bit hash.
_PHASH_SIZE = 16

_S = TypeVar("_S")


# ------------------------------------------------------------------ #
# Result + registry types                                              #
# ------------------------------------------------------------------ #


@dataclass
class DuplicateMatch:
    """Result returned by check_duplicate."""

    is_duplicate: bool
    match_type: str | None = None  # "exact" | "perceptual"
    similarity: int | None = None  # 0-100 (100 for exact)
    original_path: str | None = None  # the first-seen file this matched
    # Where the match came from: "run" (another source file this run) or
    # "destination" (a file already in the destination index). None when not
    # a duplicate.
    scope: str | None = None


@dataclass
class _ImageSig:
    phash: Any  # imagehash.ImageHash (256-bit)
    mean_rgb: tuple[float, float, float] | None
    path: str


@dataclass
class _VideoSig:
    # Per-frame list of (phash, mean_rgb) sampled at evenly-spaced fractions of
    # duration. A frame that failed to extract is stored as None so the list
    # stays positionally aligned with the sample fractions — frame i of one
    # signature always corresponds to the same timestamp fraction in another.
    frames: list[tuple[Any, tuple[float, float, float] | None] | None]
    path: str


@dataclass
class DuplicateRegistry:
    """Per-run, in-memory record of everything seen so far. Mutated by check_duplicate."""

    exact: dict[str, str] = field(default_factory=dict)  # sha256 hex -> first-seen path
    images: list[_ImageSig] = field(default_factory=list)
    videos: list[_VideoSig] = field(default_factory=list)


# ------------------------------------------------------------------ #
# Module-level helpers                                                  #
# ------------------------------------------------------------------ #


def _mean_rgb_of_image(img: Any) -> tuple[float, float, float] | None:
    """Return the mean (R, G, B) of a downsampled PIL.Image, or None."""
    try:
        small = img.convert("RGB").resize((16, 16))
        getter = getattr(small, "get_flattened_data", None) or small.getdata
        pixels = list(getter())
        n = len(pixels)
        if n == 0:
            return None
        r = sum(p[0] for p in pixels) / n
        g = sum(p[1] for p in pixels) / n
        b = sum(p[2] for p in pixels) / n
        return (r, g, b)
    except Exception:
        return None


def _color_distance(c1: tuple[float, float, float], c2: tuple[float, float, float]) -> float:
    """Euclidean distance between two RGB colour vectors."""
    return math.sqrt(sum((a - b) ** 2 for a, b in zip(c1, c2, strict=True)))


# ------------------------------------------------------------------ #
# Service                                                               #
# ------------------------------------------------------------------ #


class DuplicateService:
    """Detect duplicate files by SHA-256 hash and perceptual image/video hash."""

    # ------------------------------------------------------------------ #
    # Public API                                                            #
    # ------------------------------------------------------------------ #

    def check_duplicate(
        self,
        file_path: Path,
        registry: DuplicateRegistry,
        *,
        exact: bool = True,
        perceptual: bool = True,
        threshold: int = 95,
        sample_video: bool = True,
        destination_registry: DuplicateRegistry | None = None,
    ) -> DuplicateMatch:
        """Return a DuplicateMatch for *file_path* against *registry*.

        Registers the file's signatures when it is NOT a duplicate, so later
        files can match it.  With ``sample_video=False`` videos are only
        exact-matched (no ffmpeg frame sampling) — used by the preview/dry-run
        path to avoid expensive subprocess calls.

        ``destination_registry`` (the persisted index of media already in the
        destination) is consulted *read-only*, before the per-run registry, and
        each match is labelled via ``DuplicateMatch.scope`` so callers can route
        the two outcomes to different quarantine folders. Signatures are
        computed once and shared across both checks.
        """
        # 1. Exact SHA-256 (any file type): destination → this run.
        h: str | None = None
        if exact:
            try:
                h = self._sha256(file_path)
            except OSError as exc:
                logger.warning("Could not hash file", path=str(file_path), error=str(exc))
                return DuplicateMatch(False)
            if destination_registry is not None and h in destination_registry.exact:
                return DuplicateMatch(
                    True,
                    "exact",
                    100,
                    destination_registry.exact[h],
                    scope="destination",
                )
            if h in registry.exact:
                return DuplicateMatch(True, "exact", 100, registry.exact[h], scope="run")

        # 2. Perceptual
        #
        # The first file registered for a given content is treated as the kept
        # "original"; later perceptual matches are flagged as duplicates of it.
        # Keeping the *highest-quality* copy is the caller's responsibility:
        # SortingService/PreviewService feed files best-quality-first (see
        # ``quality_key``) so the first file seen in any duplicate group is the
        # one to keep.
        #
        # The exact hash is registered only once the file is confirmed NOT to be
        # a duplicate. A perceptual duplicate is quarantined/deleted by the
        # caller, so registering its hash as a future "original" would point
        # later byte-identical copies at a file that was never kept — instead
        # those copies are mapped straight to the kept original.
        if perceptual:
            if self._is_image(file_path):
                image_sig = self.image_signature(file_path)
                if image_sig is None:
                    # P0-3: never a *silent* drop — a HEIC/RAW/odd image that
                    # cannot produce a perceptual signature is still exact-hash
                    # deduped and date-sorted, and the gap is visible in the log.
                    logger.info(
                        "No perceptual signature (exact-hash dedup only for this file)",
                        path=str(file_path),
                    )
                else:
                    match = self._match_and_label(
                        lambda sigs: self._best_image_match(image_sig, sigs, threshold),
                        registry.images,
                        destination_registry.images if destination_registry else None,
                        registry,
                        h=h,
                        file_path=file_path,
                    )
                    if match is not None:
                        return match
                    registry.images.append(image_sig)
            elif self._is_video(file_path) and sample_video:
                video_sig = self.video_signature(file_path)
                if video_sig is not None:
                    match = self._match_and_label(
                        lambda sigs: self._best_video_match(video_sig, sigs, threshold),
                        registry.videos,
                        destination_registry.videos if destination_registry else None,
                        registry,
                        h=h,
                        file_path=file_path,
                    )
                    if match is not None:
                        return match
                    registry.videos.append(video_sig)

        if h is not None:
            registry.exact[h] = str(file_path)
        return DuplicateMatch(False)

    def _match_and_label(
        self,
        matcher: Callable[[list[_S]], DuplicateMatch | None],
        run_sigs: list[_S],
        dest_sigs: list[_S] | None,
        registry: DuplicateRegistry,
        *,
        h: str | None,
        file_path: Path,
    ) -> DuplicateMatch | None:
        """Run a perceptual matcher against the destination index, then this run.

        On a match the file's exact hash is registered pointing at the kept
        original, so later byte-identical copies map straight to it (they will
        surface as scope="run" matches whose original lives wherever the kept
        copy does — possibly the destination).
        """
        for scope, sigs in (("destination", dest_sigs), ("run", run_sigs)):
            if sigs is None:
                continue
            match = matcher(sigs)
            if match is not None:
                match.scope = scope
                if h is not None:
                    registry.exact[h] = match.original_path or str(file_path)
                return match
        return None

    def quality_key(self, path: Path) -> tuple[int, int]:
        """Return a ``(pixels, file_size)`` ranking key for choosing which of
        several duplicates to keep — higher is better.

        For images, resolution (total pixel count) dominates: of two duplicates
        the one with more pixels is the higher-quality copy, read cheaply from the
        header via ``image_dimensions``. File size breaks ties (more bytes ≈ more
        detail at equal resolution) and is the sole signal when dimensions are
        unknown. Videos are ranked by file size only — probing each video's
        resolution would cost an extra ffprobe subprocess per file, and a
        re-encode of the same clip almost always scales bytes with resolution
        anyway — which also keeps the key identical (and cheap: stat-only) on the
        sort and preview paths. Callers sort files by this key (descending) before
        the loop so the best copy of each duplicate group is processed — and kept
        — first.
        """
        try:
            size = path.stat().st_size
        except OSError:
            size = 0
        pixels = 0
        if is_image(path):
            dims = image_dimensions(path)
            if dims is not None:
                pixels = dims[0] * dims[1]
        return (pixels, size)

    def similarity_percent(self, h1: Any, h2: Any) -> int:
        """Return integer similarity 0-100. 100 = identical. Uses 256-bit hash."""
        max_distance: int = h1.hash.size  # 256 for hash_size=16
        distance: int = h1 - h2
        return round((1 - distance / max_distance) * 100)

    # ------------------------------------------------------------------ #
    # Signature builders                                                    #
    # ------------------------------------------------------------------ #

    def image_signature(self, path: Path) -> _ImageSig | None:
        """Return phash + mean_rgb + path for an image, or None on failure."""
        try:
            import imagehash

            with open_image(path) as img:
                if img is None:
                    return None
                ph = imagehash.phash(img, hash_size=_PHASH_SIZE)
                mean_color = _mean_rgb_of_image(img)
                return _ImageSig(phash=ph, mean_rgb=mean_color, path=str(path))
        except Exception as exc:
            logger.debug("image_signature failed", path=str(path), error=str(exc))
            return None

    def video_signature(self, path: Path) -> _VideoSig | None:
        """Sample frames via ffmpeg; return per-frame (phash, mean_rgb).

        Returns None if the file is unreadable, ffmpeg is unavailable, or no
        frames could be extracted.

        Frame alignment: both the original and a candidate are sampled at the
        same interior fractions of duration, so scaled/re-encoded copies of the
        same footage will produce highly similar hashes.  This is **not** robust
        to large trims or offsets — an accepted limitation.
        """
        duration = probe_duration(path)
        if duration is None or duration <= 0:
            return None
        import imagehash

        # A failed extraction stores None (not a skip) so frame i always maps to
        # the same duration fraction across signatures — otherwise one failed
        # frame would shift every later comparison onto the wrong timestamp.
        frames: list[tuple[Any, tuple[float, float, float] | None] | None] = []
        for frac in sample_fractions(_VIDEO_SAMPLE_COUNT):
            img = extract_frame(path, duration * frac)
            if img is None:
                frames.append(None)
                continue
            try:
                ph = imagehash.phash(img, hash_size=_PHASH_SIZE)
                mean_color = _mean_rgb_of_image(img)
                frames.append((ph, mean_color))
            finally:
                img.close()
        if not any(f is not None for f in frames):
            return None
        return _VideoSig(frames=frames, path=str(path))

    def video_similarity(self, a: _VideoSig, b: _VideoSig) -> int:
        """Return 0-100 perceptual similarity between two video signatures.

        Frames are compared by sample index (both sampled at the same fractions).
        A frame contributes its phash similarity **only** when the two frames'
        mean colours are close; otherwise it contributes 0.  This means solid-red
        vs solid-green clips score ~0, while scaled/re-encoded copies score ~100.
        """
        n = min(len(a.frames), len(b.frames))
        total = 0
        compared = 0
        for i in range(n):
            fa, fb = a.frames[i], b.frames[i]
            # A frame that failed to extract on either side carries no signal —
            # skip the pair rather than penalising (or rewarding) the match.
            if fa is None or fb is None:
                continue
            (pa, ca), (pb, cb) = fa, fb
            compared += 1
            if (
                ca is not None
                and cb is not None
                and _color_distance(ca, cb) > _COLOR_DISTANCE_THRESHOLD
            ):
                total += 0
            else:
                total += self.similarity_percent(pa, pb)
        if compared == 0:
            return 0
        return round(total / compared)

    # ------------------------------------------------------------------ #
    # Internal matching helpers                                             #
    # ------------------------------------------------------------------ #

    def _best_image_match(
        self, sig: _ImageSig, sigs: list[_ImageSig], threshold: int
    ) -> DuplicateMatch | None:
        """Return the best perceptual match for *sig* among *sigs*, or None.

        A colour pre-check skips stored signatures whose mean colour differs too
        much (two very differently-coloured images cannot be perceptual
        duplicates regardless of phash). The first-registered signature is the
        kept "original"; the returned match points back at it. Keeper selection
        (keep the highest-resolution copy) is handled upstream by processing
        files in descending ``quality_key`` order, so the stored signature is
        already the best copy of its group.
        """
        best_similarity = -1
        best: _ImageSig | None = None
        for stored in sigs:
            if (
                sig.mean_rgb is not None
                and stored.mean_rgb is not None
                and _color_distance(sig.mean_rgb, stored.mean_rgb) > _COLOR_DISTANCE_THRESHOLD
            ):
                continue
            sim = self.similarity_percent(sig.phash, stored.phash)
            if sim >= threshold and sim > best_similarity:
                best_similarity = sim
                best = stored

        if best is None:
            return None
        return DuplicateMatch(True, "perceptual", best_similarity, best.path)

    def _best_video_match(
        self, sig: _VideoSig, sigs: list[_VideoSig], threshold: int
    ) -> DuplicateMatch | None:
        """Return the best perceptual match for *sig* among *sigs*, or None.

        Mirrors ``_best_image_match`` using frame-wise video similarity.
        """
        best_similarity = -1
        best: _VideoSig | None = None
        for stored in sigs:
            sim = self.video_similarity(sig, stored)
            if sim >= threshold and sim > best_similarity:
                best_similarity = sim
                best = stored

        if best is None:
            return None
        return DuplicateMatch(True, "perceptual", best_similarity, best.path)

    # ------------------------------------------------------------------ #
    # Static helpers                                                        #
    # ------------------------------------------------------------------ #

    @staticmethod
    def compute_hash(file_path: Path, algorithm: str = "sha256") -> str:
        """Compute a hex digest of *file_path* using the given algorithm."""
        h = hashlib.new(algorithm)
        with open(file_path, "rb") as f:
            for chunk in iter(lambda: f.read(65536), b""):
                h.update(chunk)
        return h.hexdigest()

    @staticmethod
    def _is_image(file_path: Path) -> bool:
        return is_image(file_path)

    @staticmethod
    def _is_video(file_path: Path) -> bool:
        return is_video(file_path)

    def _sha256(self, path: Path) -> str:
        return self.compute_hash(path, "sha256")


def quality_processing_order(
    files: list[Path],
    config: Config,
    duplicates: DuplicateService | None,
    cancel_event: asyncio.Event | None = None,
    task: Task | None = None,
) -> list[int]:
    """Return indices into *files* in the order to process them.

    Shared by SortingService and PreviewService so keeper selection cannot
    drift between the sort and its preview. When perceptual de-dup is active,
    the order is by descending ``quality_key`` (pixels, then size) so the best
    copy of every duplicate group is seen — and therefore kept — first. The
    sort is stable, so equal-quality files (including byte-identical exact
    duplicates) keep their first-seen order. Otherwise the original order is
    preserved, and no per-file dimension probing is done.

    This reads image headers, so it must run off the event loop (dispatched
    via ``asyncio.to_thread``); it honours *cancel_event* by bailing to the
    identity order so the caller's loop can stop promptly. When a ``task`` is
    supplied, reports incremental "ranking" progress so this header-reading
    pre-pass doesn't sit at a frozen 0%.
    """
    if (
        duplicates is None
        or not config.remove_duplicates
        or not config.duplicate_perceptual_enabled
    ):
        return list(range(len(files)))
    total = len(files)
    if task is not None:
        task.progress.phase = "ranking"
        task.progress.current = 0
        task.progress.percentage = 0.0
    keys: list[tuple[int, int]] = []
    for i, f in enumerate(files):
        if cancel_event is not None and cancel_event.is_set():
            return list(range(len(files)))
        keys.append(duplicates.quality_key(f))
        if task is not None:
            task.progress.current = i + 1
            task.progress.percentage = round((i + 1) / total * 100, 1) if total else 0.0
    return sorted(range(len(files)), key=lambda i: keys[i], reverse=True)
