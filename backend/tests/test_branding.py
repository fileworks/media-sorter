from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

from PIL import Image

SCRIPT_PATH = Path(__file__).resolve().parents[2] / "scripts" / "generate_branding.py"
REPO_ROOT = SCRIPT_PATH.parents[1]
SPEC = importlib.util.spec_from_file_location("generate_branding", SCRIPT_PATH)
assert SPEC is not None and SPEC.loader is not None
generate_branding = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = generate_branding
SPEC.loader.exec_module(generate_branding)


def test_approved_canonical_source_and_derivatives_are_fresh() -> None:
    canonical = REPO_ROOT / generate_branding.CANONICAL

    assert generate_branding._sha256(canonical) == (generate_branding.APPROVED_SOURCE_SHA256)
    generate_branding.check_assets(REPO_ROOT)


def test_generated_branding_formats_and_dimensions() -> None:
    for relative, size in generate_branding.PNG_ICONS.items():
        with Image.open(REPO_ROOT / relative) as image:
            assert image.format == "PNG"
            assert image.mode == "RGBA"
            assert image.size == (size, size)

    for relative, (image_format, size) in generate_branding.INSTALLER_IMAGES.items():
        with Image.open(REPO_ROOT / relative) as image:
            assert image.format == image_format
            assert image.size == size
            if image_format == "BMP":
                assert image.mode == "RGB"


def test_freshness_compares_decoded_pixels_not_png_encoder_bytes(
    tmp_path: Path,
) -> None:
    image = Image.new("RGBA", (32, 32), (255, 91, 0, 255))
    uncompressed = tmp_path / "uncompressed.png"
    compressed = tmp_path / "compressed.png"
    image.save(uncompressed, "PNG", compress_level=0)
    image.save(compressed, "PNG", compress_level=9)

    assert uncompressed.read_bytes() != compressed.read_bytes()
    assert generate_branding._same_image_content(uncompressed, compressed)


def test_tauri_installer_visuals_reference_generated_assets() -> None:
    config = json.loads(
        (REPO_ROOT / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
    )
    bundle = config["tauri"]["bundle"]
    windows = bundle["windows"]

    assert windows["nsis"] == {
        "installMode": "both",
        "installerIcon": "icons/icon.ico",
        "headerImage": "installer/nsis-header.bmp",
        "sidebarImage": "installer/nsis-sidebar.bmp",
    }
    assert windows["wix"] == {
        "bannerPath": "installer/wix-banner.bmp",
        "dialogImagePath": "installer/wix-dialog.bmp",
    }
    assert bundle["dmg"] == {
        "background": "installer/dmg-background.png",
        "windowSize": {"width": 660, "height": 400},
        "appPosition": {"x": 180, "y": 200},
        "applicationFolderPosition": {"x": 480, "y": 200},
    }
    assert bundle["dmg"]["appPosition"] != bundle["dmg"]["applicationFolderPosition"]


def test_ci_and_release_builds_reject_stale_branding() -> None:
    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    ci_workflow = (REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    release_workflow = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "branding-check" in makefile
    assert "make branding-check" in ci_workflow
    assert "make branding-check" in release_workflow
