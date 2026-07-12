"""Repair service — validate and attempt to fix corrupted media files."""

import asyncio
import subprocess
from pathlib import Path

from app.core.logging_config import get_logger
from app.utils.ffmpeg_utils import run_ffprobe_json
from app.utils.media_utils import is_image, is_video

logger = get_logger(__name__)


class RepairService:
    def validate_file(self, path: Path) -> tuple[bool, str | None]:
        """Return (is_valid, error_message).

        Dispatches to format-specific validators; other types are assumed valid.
        """
        if not path.exists():
            return False, f"File not found: {path}"

        if is_image(path):
            return self.validate_image(path)

        if is_video(path):
            return self.validate_video(path)

        return True, None

    def repair_file(self, path: Path) -> bool:
        """Attempt to repair *path* in-place.

        Returns True if the repaired file was written successfully.
        """
        if is_image(path):
            return self.repair_image(path)

        if is_video(path):
            return self.repair_video(path)

        return False

    @staticmethod
    def _repair_tmp(path: Path) -> Path:
        """Return an unambiguous temp path: <stem>.repair.tmp<suffix>.

        The suffix keeps the format recognisable for the encoder, but
        '.repair.tmp' in the name prevents it from being re-scanned as
        a real media file on a later run.
        """
        return path.with_name(path.stem + ".repair.tmp" + path.suffix)

    @staticmethod
    def validate_image(path: Path) -> tuple[bool, str | None]:
        """Validate image integrity.

        HEIC/RAW files are opened via open_image (uses pillow-heif / rawpy).
        Standard formats use a fresh Image.open + verify() call so that we
        never call verify() on an already-processed image object.
        """
        from app.services.filesystem_service import HEIC_EXTENSIONS, RAW_EXTENSIONS, open_image

        suffix = path.suffix.lower()
        if suffix in HEIC_EXTENSIONS or suffix in RAW_EXTENSIONS:
            with open_image(path) as img:
                if img is not None:
                    return True, None
                return False, "Could not decode"
        try:
            from PIL import Image

            with Image.open(path) as img:
                img.verify()
            return True, None
        except Exception as exc:
            return False, str(exc)

    @staticmethod
    def validate_video(path: Path) -> tuple[bool, str | None]:
        """Fast structural validation via ffprobe: container parses and has ≥1 video stream.

        Does NOT do a full decode (Known Issue #9 fix).
        Tolerates missing ffprobe/ffmpeg by returning (True, None) — don't penalise
        users who don't have ffmpeg installed.
        """
        try:
            stderr_buf: list[str] = []
            data = run_ffprobe_json(
                path, "stream=codec_type", select_streams="v:0", timeout=15, stderr_out=stderr_buf
            )
            if data is None:
                return False, (stderr_buf[0] if stderr_buf else None) or "ffprobe reported errors"
            streams = data.get("streams", [])
            if not any(s.get("codec_type") == "video" for s in streams):
                return False, "No decodable video stream found"
            return True, None
        except subprocess.TimeoutExpired:
            return False, "Validation timed out"
        except FileNotFoundError:
            logger.debug("ffprobe not found; skipping video validation", path=str(path))
            return True, None  # ffmpeg/ffprobe absent → don't fail the file
        except Exception as exc:
            return False, str(exc)

    @staticmethod
    def repair_image(path: Path) -> bool:
        """Re-encode to a temp, validate it, swap in only if valid.

        Returns True only when a VALID file was produced.
        Never leaves a broken file or a *.repair.tmp.* behind.
        Never replaces the original with an invalid file.
        Scopes LOAD_TRUNCATED_IMAGES so the global flag is never leaked.
        RAW files are not safely re-encodable in-place — returns False immediately.
        """
        from PIL import Image, ImageFile

        from app.services.filesystem_service import RAW_EXTENSIONS, open_image

        suffix = path.suffix.lower()
        if suffix in RAW_EXTENSIONS:
            return False  # RAW is not safely re-encodable in place

        tmp = RepairService._repair_tmp(path)
        prev = ImageFile.LOAD_TRUNCATED_IMAGES
        try:
            ImageFile.LOAD_TRUNCATED_IMAGES = True  # scoped — restored in finally
            with open_image(path) as img:
                if img is None:
                    return False
                img.load()
                # JPEG-suffixed temps can't hold alpha/palette — flatten like conversion does.
                out_img = img
                if suffix in {".jpg", ".jpeg", ".jpe", ".jfif"} and img.mode in (
                    "RGBA",
                    "LA",
                    "P",
                ):
                    bg = Image.new("RGB", img.size, (255, 255, 255))
                    alpha = img.split()[-1] if img.mode in ("RGBA", "LA") else None
                    bg.paste(img.convert("RGBA"), mask=alpha)
                    out_img = bg
                out_img.save(tmp)
            ok, _ = RepairService.validate_image(tmp)
            if not ok:
                tmp.unlink(missing_ok=True)
                return False
            tmp.replace(path)
            logger.info("Repaired image", path=str(path))
            return True
        except Exception as exc:
            logger.warning("Image repair failed", path=str(path), error=str(exc))
            tmp.unlink(missing_ok=True)
            return False
        finally:
            ImageFile.LOAD_TRUNCATED_IMAGES = prev  # never leak the global mutation

    @staticmethod
    def repair_video(path: Path) -> bool:
        """Remux to a temp, validate, swap in only on success.

        Invariant: after this call, the file at *path* is either the unchanged
        original (False returned) or a verified-valid replacement (True returned).
        No *.repair.tmp.* leftover is ever left on disk.
        """
        tmp = RepairService._repair_tmp(path)
        try:
            result = subprocess.run(
                [
                    "ffmpeg",
                    "-err_detect",
                    "ignore_err",
                    "-i",
                    str(path),
                    "-c",
                    "copy",
                    "-y",
                    str(tmp),
                ],
                capture_output=True,
                text=True,
                timeout=3600,
            )
            if result.returncode == 0 and tmp.exists():
                valid, _ = RepairService.validate_video(tmp)
                if valid:
                    tmp.replace(path)
                    logger.info("Repaired video", path=str(path))
                    return True
            logger.warning("Video repair failed", path=str(path), stderr=result.stderr[:200])
            tmp.unlink(missing_ok=True)
            return False
        except subprocess.TimeoutExpired:
            logger.warning("Video repair timed out", path=str(path))
            tmp.unlink(missing_ok=True)
            return False
        except FileNotFoundError:
            logger.debug("ffmpeg not found; cannot repair video", path=str(path))
            return False
        except Exception as exc:
            logger.warning("Video repair error", path=str(path), error=str(exc))
            tmp.unlink(missing_ok=True)
            return False

    async def attempt_repair(self, path: Path) -> Path | None:
        """Async wrapper around ``repair_file``.

        The repair itself is blocking work (full PIL re-encode / ffmpeg remux),
        so it is dispatched to a worker thread — never run on the event loop.
        """
        success = await asyncio.to_thread(self.repair_file, path)
        return path if success else None
