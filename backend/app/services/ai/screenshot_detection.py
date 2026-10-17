"""Recognize screenshots from what the operating system wrote, not from pixels (OPT-04).

Phones and desktops label their screenshots: iOS and macOS store
``UserComment = "Screenshot"`` in EXIF or XMP, and every major platform names the
file after the act ("Screenshot_20240101-…", "Bildschirmfoto 2024-…",
"Capture d’écran …"). Those signals are far more precise than asking the model
whether pixels look like a screen, cost no inference, and can be explained in
Review. A file without them is left to the model as before.
"""

from __future__ import annotations

import re
import unicodedata
from pathlib import Path
from typing import Literal

from app.core.logging_config import get_logger
from app.utils.media_utils import is_image

logger = get_logger(__name__)

ScreenshotEvidence = Literal["file_name", "embedded_metadata"]

#: Words platforms put at the start of a screenshot's file name, normalised
#: (lower case, accents removed, separators as spaces).
_NAME_PREFIXES = (
    "screenshot",
    "screen shot",
    "bildschirmfoto",
    "bildschirmaufnahme",
    "capture d ecran",
    "captura de pantalla",
    "captura de ecra",
    "schermafbeelding",
    "schermata",
    "zrzut ekranu",
    "skarmbild",
    "skaermbillede",
    "skjermbilde",
)
_NAME = re.compile(r"^(?:" + "|".join(re.escape(p) for p in _NAME_PREFIXES) + r")\b")
_EXIF_IFD = 0x8769
_USER_COMMENT = 0x9286


def _normalized_stem(path: Path) -> str:
    text = unicodedata.normalize("NFKD", path.stem.casefold())
    text = "".join(char for char in text if not unicodedata.combining(char))
    return " ".join(re.sub(r"[_\-.’'()\[\]]+", " ", text).split())


def screenshot_evidence(path: Path) -> ScreenshotEvidence | None:
    """Why *path* is a screenshot according to its platform, or ``None``."""
    if not is_image(path):
        return None
    if _NAME.match(_normalized_stem(path)):
        return "file_name"
    try:
        from PIL import Image

        with Image.open(path) as image:
            comment = image.getexif().get_ifd(_EXIF_IFD).get(_USER_COMMENT)
            if isinstance(comment, bytes):
                comment = comment.decode("ascii", "ignore")
            if isinstance(comment, str) and comment.strip("\x00 ").endswith("Screenshot"):
                return "embedded_metadata"
            xmp = image.info.get("XML:com.adobe.xmp") or image.info.get("xmp")
            if isinstance(xmp, bytes):
                xmp = xmp.decode("utf-8", "ignore")
            if isinstance(xmp, str) and re.search(
                r"UserComment[^<]*>\s*(?:<[^>]+>\s*)*Screenshot\s*<", xmp
            ):
                return "embedded_metadata"
    except Exception as exc:
        logger.debug("Screenshot metadata unreadable", error=type(exc).__name__)
    return None
