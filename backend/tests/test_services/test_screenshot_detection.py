"""OPT-04 — screenshots recognized from what the platform wrote, before any model."""

from __future__ import annotations

from pathlib import Path
from typing import Any, cast

import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai.ai_tagging_service import AITaggingService
from app.services.ai.category_classifier_service import CategoryClassifierService
from app.services.ai.encoder_protocol import VisionEncoder
from app.services.ai.screenshot_detection import screenshot_evidence


def _png(path: Path, **save: Any) -> Path:
    Image.new("RGB", (40, 30), "white").save(path, format="PNG", **save)
    return path


@pytest.mark.parametrize(
    "name",
    [
        "Screenshot_20240101-101010.png",
        "Screenshot 2024-03-02 at 10.11.12.png",
        "Screen Shot 2019-05-01 at 09.00.00.png",
        "Bildschirmfoto 2024-03-02 um 10.11.12.png",
        "Capture d’écran 2024-03-02 à 10.11.12.png",
        "Captura de pantalla 2024-03-02 101112.png",
        "Schermafbeelding 2024-03-02 101112.png",
    ],
)
def test_platform_file_names_are_recognized(tmp_path: Path, name: str) -> None:
    assert screenshot_evidence(_png(tmp_path / name)) == "file_name"


@pytest.mark.parametrize(
    "name",
    ["IMG_1234.png", "my screenshot.png", "Screenshots of the trip.png", "screenshotting.png"],
)
def test_ordinary_names_are_not(tmp_path: Path, name: str) -> None:
    assert screenshot_evidence(_png(tmp_path / name)) is None


def test_an_ios_user_comment_marks_a_screenshot(tmp_path: Path) -> None:
    image = Image.new("RGB", (40, 30), "white")
    exif = image.getexif()
    exif.get_ifd(0x8769)[0x9286] = b"ASCII\x00\x00\x00Screenshot"
    path = tmp_path / "IMG_0001.png"
    image.save(path, format="PNG", exif=exif.tobytes())

    assert screenshot_evidence(path) == "embedded_metadata"


def test_macos_xmp_marks_a_screenshot(tmp_path: Path) -> None:
    from PIL import PngImagePlugin

    info = PngImagePlugin.PngInfo()
    info.add_itxt(
        "XML:com.adobe.xmp",
        '<x:xmpmeta><rdf:Description><exif:UserComment><rdf:Alt><rdf:li xml:lang="x-default">'
        "Screenshot</rdf:li></rdf:Alt></exif:UserComment></rdf:Description></x:xmpmeta>",
    )
    path = _png(tmp_path / "IMG_0002.png", pnginfo=info)

    assert screenshot_evidence(path) == "embedded_metadata"


def test_non_images_are_never_screenshots(tmp_path: Path) -> None:
    text = tmp_path / "Screenshot notes.txt"
    text.write_text("not an image", encoding="utf-8")

    assert screenshot_evidence(text) is None


class _NoModel(VisionEncoder):
    """Fails the test if the model is consulted."""

    def embed_image(self, image: Any) -> Any:
        raise AssertionError("the model must not be asked about a known screenshot")

    def embed_texts(self, texts: list[str]) -> Any:
        raise AssertionError("the model must not be asked about a known screenshot")


def test_a_known_screenshot_is_filed_without_the_model(tmp_path: Path) -> None:
    photo = _png(tmp_path / "Bildschirmfoto 2024-03-02 um 10.11.12.png")
    config = Config(language="de", categorize_enabled=True)

    result = CategoryClassifierService(config, cast("VisionEncoder", _NoModel())).classify_file(
        photo
    )

    assert result.category == "Bildschirmfotos"
    assert result.basis == "file_name"


def test_a_known_screenshot_gets_the_vocabularys_screenshot_tag(tmp_path: Path) -> None:
    photo = _png(tmp_path / "Screenshot_20240101-101010.png")
    service = AITaggingService(Config(ai_tagging_enabled=True))
    service._provider = None
    service._provider_built = True

    assert service.tag_file(photo) == ["screenshot"]
