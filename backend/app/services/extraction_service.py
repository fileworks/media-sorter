"""Date extraction service — EXIF → video metadata → filename → filesystem."""

import re
from dataclasses import dataclass
from datetime import date, datetime, timezone
from pathlib import Path

from app.core.logging_config import get_logger
from app.services.filesystem_service import load_exif_dict
from app.utils.ffmpeg_utils import run_ffprobe_json
from app.utils.media_utils import is_image, is_video

logger = get_logger(__name__)

DateResult = tuple[date | None, str]  # (date, source)

_FILENAME_PATTERNS = [
    re.compile(r"(\d{4})[_\-](\d{2})[_\-](\d{2})"),  # YYYY-MM-DD / YYYY_MM_DD
    re.compile(r"(\d{4})(\d{2})(\d{2})"),  # YYYYMMDD
]

# Common camera-reset sentinel dates (year, month, day) that indicate the
# clock was never set — a genuine photo taken on these exact dates is
# flagged and the pipeline falls back to filename/filesystem.
_RESET_SENTINELS: frozenset[tuple[int, int, int]] = frozenset(
    {(1904, 1, 1), (1970, 1, 1), (1980, 1, 1), (2000, 1, 1), (2002, 1, 1)}
)


@dataclass
class ExtractionResult:
    extracted_date: date | None
    source: str  # "exif" | "video_metadata" | "filename" | "filesystem" | "none"
    suspicious: bool = False
    suspicious_reason: str = ""
    fallback_date: date | None = None


class DateExtractionService:
    """Extract creation dates from media files with a multi-source fallback chain.

    Priority: EXIF → video metadata → filename pattern → filesystem mtime.
    All returned *date* objects are calendar dates (no time component);
    use the static helpers for future-date or validity checks.
    """

    # ------------------------------------------------------------------ #
    # Private extraction methods                                            #
    # ------------------------------------------------------------------ #

    def _from_exif(self, path: Path) -> DateResult:
        try:
            import piexif

            exif_data = load_exif_dict(path)
            if exif_data is None:
                return None, "none"

            for tag in (piexif.ExifIFD.DateTimeOriginal, piexif.ExifIFD.DateTimeDigitized):
                raw = exif_data.get("Exif", {}).get(tag)
                if raw:
                    dt = datetime.strptime(raw.decode(), "%Y:%m:%d %H:%M:%S")
                    return dt.date(), "exif"

            # Fallback to IFD0 DateTime
            raw = exif_data.get("0th", {}).get(piexif.ImageIFD.DateTime)
            if raw:
                dt = datetime.strptime(raw.decode(), "%Y:%m:%d %H:%M:%S")
                return dt.date(), "exif"

        except Exception as exc:
            logger.debug("EXIF extraction failed", path=str(path), error=str(exc))

        return None, "none"

    def _from_video(self, path: Path) -> DateResult:
        try:
            data = run_ffprobe_json(path, "format_tags=creation_time", timeout=10)
            if data is None:
                return None, "none"
            creation_time = data.get("format", {}).get("tags", {}).get("creation_time")
            if not creation_time:
                return None, "none"
            dt = datetime.fromisoformat(creation_time.replace("Z", "+00:00"))
            # ffprobe occasionally emits naive datetimes for malformed
            # containers — assume UTC (ffprobe's documented contract).
            if dt.tzinfo is None:
                dt = dt.replace(tzinfo=timezone.utc)
            return dt.astimezone(timezone.utc).date(), "video_metadata"
        except Exception as exc:
            logger.debug("Video date extraction failed", path=str(path), error=str(exc))
        return None, "none"

    def _from_filename(self, path: Path) -> DateResult:
        name = path.stem
        for pattern in _FILENAME_PATTERNS:
            m = pattern.search(name)
            if m:
                try:
                    d = date(int(m.group(1)), int(m.group(2)), int(m.group(3)))
                    return d, "filename"
                except ValueError:
                    pass
        return None, "none"

    def _from_filesystem(self, path: Path) -> DateResult:
        try:
            ts = path.stat().st_mtime
            return datetime.fromtimestamp(ts, tz=timezone.utc).date(), "filesystem"
        except OSError:
            return None, "none"

    def extract_detailed(self, file_path: Path, check_suspicious: bool = True) -> ExtractionResult:
        """Return an ExtractionResult for *file_path*.

        Runs the EXIF sanity-check when ``check_suspicious`` is True.
        """
        primary_date: date | None = None
        primary_source: str = "none"

        if is_image(file_path):
            raw_date, raw_source = self._from_exif(file_path)
            if raw_date is not None:
                suspicious = self._resolve_suspicious_date(
                    file_path, raw_date, raw_source, check_suspicious
                )
                if suspicious is not None:
                    return suspicious
                primary_date = raw_date
                primary_source = raw_source

        if primary_date is None and is_video(file_path):
            raw_date, raw_source = self._from_video(file_path)
            if raw_date is not None:
                suspicious = self._resolve_suspicious_date(
                    file_path, raw_date, raw_source, check_suspicious
                )
                if suspicious is not None:
                    return suspicious
                primary_date, primary_source = raw_date, raw_source

        if primary_date is None:
            primary_date, primary_source = self._from_filename(file_path)
            # Reject epoch/sentinel filename dates (e.g. "19700101_x.jpg") just
            # like the suspicious-EXIF fallback path does — the same file must
            # get the same verdict whether or not it also had a bad EXIF date.
            if primary_date is not None and self._is_sentinel(primary_date):
                primary_date, primary_source = None, "none"

        if primary_date is None:
            primary_date, primary_source = self._from_filesystem(file_path)
            # Reject epoch/sentinel filesystem dates — treat as unknown.
            if primary_date is not None and self._is_sentinel(primary_date):
                primary_date, primary_source = None, "none"

        return ExtractionResult(extracted_date=primary_date, source=primary_source)

    def _resolve_suspicious_date(
        self,
        file_path: Path,
        raw_date: date,
        raw_source: str,
        check_suspicious: bool,
    ) -> ExtractionResult | None:
        """Apply the same sanity and fallback chain to EXIF and video dates."""
        # Exact reset sentinels are never valid metadata. Broader plausibility
        # policy (old/future dates) remains controlled by the user setting.
        if not check_suspicious and not self._is_sentinel(raw_date):
            return None
        dt = datetime(raw_date.year, raw_date.month, raw_date.day, tzinfo=timezone.utc)
        is_suspicious, reason = self._is_suspicious_date(dt)
        if not is_suspicious:
            return None

        fallback_date, fallback_source = self._from_filename(file_path)
        if fallback_date is None:
            fallback_date, fallback_source = self._from_filesystem(file_path)
        if fallback_date is not None and self._is_sentinel(fallback_date):
            fallback_date, fallback_source = None, "none"
        return ExtractionResult(
            extracted_date=fallback_date,
            source=fallback_source if fallback_date is not None else raw_source,
            suspicious=True,
            suspicious_reason=reason,
            fallback_date=fallback_date,
        )

    @staticmethod
    def _is_sentinel(d: date) -> bool:
        """True for exact clock-reset sentinel dates."""
        return (d.year, d.month, d.day) in _RESET_SENTINELS

    def _is_suspicious_date(self, dt: datetime) -> "tuple[bool, str]":
        """Return (is_suspicious, reason).

        Uses exact date sentinels rather than blanket year blocks, so a genuine
        photo taken in 2000 (on any day other than Jan 1) is not mis-flagged.
        """
        now = datetime.now(timezone.utc)
        if dt.year < 1990:
            return True, f"Year {dt.year} predates digital cameras"
        if (dt.year, dt.month, dt.day) in _RESET_SENTINELS:
            return True, f"{dt.date()} is a common camera-reset default"
        if dt.year > now.year + 1:
            return True, f"Year {dt.year} is in the future"
        return False, ""

    def extract_camera_model(self, path: Path) -> str | None:
        """Extract camera make+model from EXIF.

        Uses the shared ``load_exif_dict`` loader, so HEIC/RAW sources (e.g.
        iPhone photos) resolve a camera folder just like their JPEG siblings.
        Returns a sanitised string like 'iPhone-15-Pro', or None.
        """
        try:
            import piexif

            exif_data = load_exif_dict(path)
            if exif_data is None:
                return None
            make = (
                exif_data.get("0th", {})
                .get(piexif.ImageIFD.Make, b"")
                .decode("utf-8", errors="ignore")
                .strip()
            )
            model = (
                exif_data.get("0th", {})
                .get(piexif.ImageIFD.Model, b"")
                .decode("utf-8", errors="ignore")
                .strip()
            )
            # Skip empties cleanly so we never produce "_-_"-style folder names.
            if make and model and model.lower().startswith(make.lower()):
                name = model.strip()
            else:
                parts = [p for p in (make, model) if p]
                name = " ".join(parts)
            if not name:
                return None
            cleaned = re.sub(r"[^\w\-]", "-", name).strip("-")
            return cleaned or None
        except Exception:
            return None

    # ------------------------------------------------------------------ #
    # Static helpers                                                        #
    # ------------------------------------------------------------------ #

    @staticmethod
    def is_future_date(d: date | datetime) -> bool:
        """Return True if *d* is strictly after today (UTC)."""
        today = datetime.now(timezone.utc).date()
        if isinstance(d, datetime):
            d = d.date()
        return d > today

    @staticmethod
    def is_valid_date(d: date | datetime | None) -> bool:
        """Return True if *d* falls in the plausible [1990, today] range."""
        if d is None:
            return False
        today = datetime.now(timezone.utc).date()
        if isinstance(d, datetime):
            d = d.date()
        return date(1990, 1, 1) <= d <= today
