"""Real EXIF fixtures: camera metadata is nested, optional and untrusted."""

from pathlib import Path

import pytest
from PIL import Image

from app.core.config import Config
from app.services.ai.ai_tagging_service import AITaggingService


@pytest.mark.parametrize("language,expected", [("en", "landscape"), ("de", "Landschaft")])
def test_scene_capture_tag_is_read_from_exif_sub_ifd(
    tmp_path: Path, language: str, expected: str
) -> None:
    path = tmp_path / "camera.jpg"
    metadata = Image.Exif()
    metadata[34665] = {41990: 1}  # Exif IFD → SceneCaptureType: landscape.
    Image.new("RGB", (32, 24)).save(path, exif=metadata)
    original = path.read_bytes()
    config = Config.from_dict({"language": language, "ai_tagging_enabled": True})

    assert AITaggingService(config).tag_file(path) == [expected]
    assert path.read_bytes() == original


def test_disabled_tagging_does_not_emit_metadata_tags(tmp_path: Path) -> None:
    path = tmp_path / "camera.jpg"
    metadata = Image.Exif()
    metadata[34665] = {41990: 1}
    Image.new("RGB", (32, 24)).save(path, exif=metadata)

    assert AITaggingService(Config(ai_tagging_enabled=False)).tag_file(path) == []
