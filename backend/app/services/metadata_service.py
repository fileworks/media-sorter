"""Metadata service — read/write EXIF and video metadata."""

import contextlib
import os
import subprocess
from datetime import datetime
from pathlib import Path
from typing import Any
from xml.sax.saxutils import escape

from app.core.logging_config import get_logger
from app.utils.ffmpeg_utils import run_ffprobe_json
from app.utils.media_utils import is_video

logger = get_logger(__name__)

# piexif can only WRITE EXIF to these container types
_EXIF_EXTENSIONS = {".jpg", ".jpeg", ".tiff", ".tif"}

# MP4/MOV-family containers need ``-movflags use_metadata_tags`` for ffmpeg to
# write a non-standard ``keywords`` tag; other containers (mkv/webm/avi) accept
# arbitrary metadata keys directly.
_MOV_LIKE_EXTENSIONS = {".mp4", ".mov", ".m4v", ".m4a"}


class MetadataService:
    def set_creation_date(self, path: Path, dt: datetime) -> bool:
        """Write *dt* as the EXIF DateTimeOriginal / DateTime for supported images.

        Returns True on success, False otherwise (including unsupported formats
        — the caller can record whether the override actually applied).
        """
        if path.suffix.lower() not in _EXIF_EXTENSIONS:
            return False
        try:
            import piexif

            date_str = dt.strftime("%Y:%m:%d %H:%M:%S").encode()
            exif_dict: dict[str, Any] = {"Exif": {}, "0th": {}}

            with contextlib.suppress(Exception):
                exif_dict = piexif.load(str(path))

            exif_dict.setdefault("Exif", {})[piexif.ExifIFD.DateTimeOriginal] = date_str
            exif_dict.setdefault("Exif", {})[piexif.ExifIFD.DateTimeDigitized] = date_str
            exif_dict.setdefault("0th", {})[piexif.ImageIFD.DateTime] = date_str

            piexif.insert(piexif.dump(exif_dict), str(path))
            logger.debug("Set creation date", path=str(path), date=dt.isoformat())
            return True

        except Exception as exc:
            logger.warning("Failed to set EXIF date", path=str(path), error=str(exc))
            return False

    def write_keywords(self, path: Path, keywords: list[str]) -> str:
        """Embed *keywords* (tags) into the media file at *path*.

        Strategy by type:
          * JPEG/TIFF → EXIF ``XPKeywords`` (the Windows Explorer "Tags" field)
            plus ``ImageDescription``, merged into existing EXIF via piexif.
          * Video (mp4/mov/mkv/…) → an ffmpeg stream-copy remux that writes a
            ``keywords`` metadata tag (no re-encode).
          * Everything else (PNG/HEIC/RAW) → a portable ``<file>.xmp`` sidecar
            with a ``dc:subject`` bag, read by digiKam/Lightroom/Apple Photos.

        Returns ``"embedded"``, ``"sidecar"``, or ``""`` (nothing written). Always
        best-effort: a failure logs a warning and returns ``""`` so the caller
        (sort pipeline) is never aborted by a tagging-metadata write.
        """
        cleaned = [k.strip() for k in keywords if k and k.strip()]
        if not cleaned:
            return ""

        suffix = path.suffix.lower()
        if suffix in _EXIF_EXTENSIONS:
            return "embedded" if self._write_exif_keywords(path, cleaned) else ""
        if is_video(path):
            return "embedded" if self._write_video_keywords(path, cleaned) else ""
        return "sidecar" if self._write_xmp_sidecar(path, cleaned) else ""

    @staticmethod
    def _write_exif_keywords(path: Path, keywords: list[str]) -> bool:
        """Write keywords to EXIF XPKeywords + ImageDescription (JPEG/TIFF)."""
        try:
            import piexif

            exif_dict: dict[str, Any] = {"0th": {}, "Exif": {}}
            with contextlib.suppress(Exception):
                exif_dict = piexif.load(str(path))

            # XPKeywords: UCS-2 (UTF-16LE), semicolon-separated, NUL-terminated —
            # this is the field Windows Explorer surfaces as "Tags".
            xp = ";".join(keywords).encode("utf-16le") + b"\x00\x00"
            exif_dict.setdefault("0th", {})[piexif.ImageIFD.XPKeywords] = xp
            # ImageDescription is ASCII-typed; keep it broadly readable.
            desc = ", ".join(keywords).encode("ascii", "ignore")
            exif_dict.setdefault("0th", {})[piexif.ImageIFD.ImageDescription] = desc

            piexif.insert(piexif.dump(exif_dict), str(path))
            logger.debug("Embedded keywords in EXIF", path=str(path), count=len(keywords))
            return True
        except Exception as exc:
            logger.warning("Failed to embed EXIF keywords", path=str(path), error=str(exc))
            return False

    @staticmethod
    def _write_video_keywords(path: Path, keywords: list[str]) -> bool:
        """Write a ``keywords`` metadata tag to a video via an ffmpeg remux."""
        joined = ",".join(keywords)
        tmp = path.with_name(f"{path.stem}.tagtmp{path.suffix}")
        cmd = ["ffmpeg", "-v", "error", "-i", str(path), "-map_metadata", "0", "-c", "copy"]
        if path.suffix.lower() in _MOV_LIKE_EXTENSIONS:
            cmd += ["-movflags", "use_metadata_tags"]
        cmd += ["-metadata", f"keywords={joined}", "-y", str(tmp)]
        try:
            result = subprocess.run(cmd, capture_output=True, timeout=120)
            if result.returncode != 0 or not tmp.exists() or tmp.stat().st_size == 0:
                with contextlib.suppress(OSError):
                    tmp.unlink(missing_ok=True)
                logger.warning(
                    "Failed to embed video keywords",
                    path=str(path),
                    stderr=result.stderr[:200].decode("utf-8", "replace"),
                )
                return False
            os.replace(tmp, path)
            logger.debug("Embedded keywords in video", path=str(path), count=len(keywords))
            return True
        except (FileNotFoundError, subprocess.TimeoutExpired, OSError) as exc:
            with contextlib.suppress(OSError):
                tmp.unlink(missing_ok=True)
            logger.warning("Failed to embed video keywords", path=str(path), error=str(exc))
            return False

    @staticmethod
    def _write_xmp_sidecar(path: Path, keywords: list[str]) -> bool:
        """Write a portable ``<file>.<ext>.xmp`` sidecar with a dc:subject bag.

        The double-extension convention (``IMG_1.png.xmp``) keeps sidecars
        unique per file — ``with_suffix`` would make ``IMG_1.png`` and
        ``IMG_1.heic`` silently overwrite each other's tags.
        """
        sidecar = path.with_name(path.name + ".xmp")
        items = "\n".join(f"     <rdf:li>{escape(k)}</rdf:li>" for k in keywords)
        xml = (
            '<?xml version="1.0" encoding="UTF-8"?>\n'
            '<x:xmpmeta xmlns:x="adobe:ns:meta/">\n'
            ' <rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#"\n'
            '          xmlns:dc="http://purl.org/dc/elements/1.1/">\n'
            '  <rdf:Description rdf:about="">\n'
            "   <dc:subject>\n"
            "    <rdf:Bag>\n"
            f"{items}\n"
            "    </rdf:Bag>\n"
            "   </dc:subject>\n"
            "  </rdf:Description>\n"
            " </rdf:RDF>\n"
            "</x:xmpmeta>\n"
        )
        try:
            sidecar.write_text(xml, encoding="utf-8")
            logger.debug("Wrote XMP sidecar", path=str(sidecar), count=len(keywords))
            return True
        except OSError as exc:
            logger.warning("Failed to write XMP sidecar", path=str(sidecar), error=str(exc))
            return False

    @staticmethod
    def write_exif(path: Path, exif_dict: dict[str, Any]) -> bool:
        """Write a full piexif-formatted *exif_dict* to *path*.

        Returns True on success. Only works for JPEG/TIFF.
        """
        try:
            import piexif

            piexif.insert(piexif.dump(exif_dict), str(path))
            logger.debug("Wrote EXIF", path=str(path))
            return True
        except Exception as exc:
            logger.warning("Failed to write EXIF", path=str(path), error=str(exc))
            return False

    @staticmethod
    def read_video_metadata(path: Path) -> dict[str, Any]:
        """Return ffprobe format metadata for *path* (creation_time, duration, etc.)."""
        try:
            data = run_ffprobe_json(path, "format_tags=creation_time:format=duration", timeout=10)
            if data is not None:
                fmt = data.get("format", {})
                return fmt if isinstance(fmt, dict) else {}
        except Exception as exc:
            logger.debug("ffprobe failed", path=str(path), error=str(exc))
        return {}
