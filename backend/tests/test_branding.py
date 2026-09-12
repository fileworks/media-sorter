from __future__ import annotations

import importlib.util
import json
import sys
from pathlib import Path

import pytest
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


def test_canonical_geometry_is_a_contract_not_a_hash() -> None:
    """The tile inset and the mark's centring are asserted, not just the bytes.

    The tile is drawn on Apple's documented 824/1024 macOS grid. macOS 26
    normalises a legacy `.icns` onto that plate itself, so this is no longer
    what decides the icon's size there — but it is what Windows and Linux are
    handed unaltered, and what keeps macOS from upscaling to reach the grid.
    It has shipped wrong more than once because the geometry lived only inside
    an approved blob.
    """
    with Image.open(REPO_ROOT / generate_branding.CANONICAL) as image:
        source = image.convert("RGBA")

    canvas = source.size[0]
    tile = generate_branding._bounding_box(source, lambda pixel: pixel[3] > 128)
    edge = tile[2] - tile[0] + 1

    assert abs(edge - round(canvas * generate_branding.TILE_RATIO)) <= (
        generate_branding.TILE_TOLERANCE_PX
    )
    # Apple's grid exactly: 824 of 1024, which is 100px — 9.77% — a side. The
    # bound used to start at 10%, which excluded the very value it was meant to
    # describe; the upper bound is what actually matters, since the failure
    # mode this guards is a tile so inset that the mark is lost in the plate.
    assert edge == round(canvas * 824 / 1024), "the tile is Apple's 824/1024 grid"
    assert 0.09 <= (1 - edge / canvas) / 2 <= 0.20, "macOS wants 9-20% clear space"

    full_bleed = Image.new("RGBA", (canvas, canvas), (239, 234, 226, 255))
    full_bleed.paste((42, 37, 31, 255), (400, 400, 600, 600))
    with pytest.raises(generate_branding.BrandingError, match="tile width"):
        generate_branding._validate_geometry(Path("full-bleed.png"), full_bleed)

    off_centre = Image.new("RGBA", (canvas, canvas), (0, 0, 0, 0))
    off_centre.paste((239, 234, 226, 255), (tile[0], tile[1], tile[2] + 1, tile[3] + 1))
    off_centre.paste((42, 37, 31, 255), (400, 500, 600, 700))
    with pytest.raises(generate_branding.BrandingError, match="off centre"):
        generate_branding._validate_geometry(Path("off-centre.png"), off_centre)


def test_macos_bundle_ships_the_verified_icns() -> None:
    """Tauri only copies an `.icns` it is given; otherwise it invents one.

    Without this entry the bundler synthesised an icon set from the PNG list,
    so the `.icns` this script generates and `--check` verifies never shipped,
    and the bundle carried no 1024px slice for a Retina dock.
    """
    config = json.loads(
        (REPO_ROOT / "frontend/src-tauri/tauri.conf.json").read_text(encoding="utf-8")
    )

    assert "icons/icon.icns" in config["bundle"]["icon"]
    assert 1024 in generate_branding.ICNS_SIZES


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
    bundle = config["bundle"]
    windows = bundle["windows"]

    # Cargo's package name is `media-sorter`; without an explicit main binary
    # name Tauri v2 installs `media-sorter.exe`, while the branded package
    # smoke tests and user-facing documentation correctly expect MediaSorter.
    assert config["mainBinaryName"] == config["productName"] == "MediaSorter"
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
    assert bundle["macOS"]["dmg"] == {
        "background": "installer/dmg-background.png",
        "windowSize": {"width": 660, "height": 400},
        "appPosition": {"x": 180, "y": 200},
        "applicationFolderPosition": {"x": 480, "y": 200},
    }
    assert (
        bundle["macOS"]["dmg"]["appPosition"] != bundle["macOS"]["dmg"]["applicationFolderPosition"]
    )


def test_ci_and_release_builds_reject_stale_branding() -> None:
    makefile = (REPO_ROOT / "Makefile").read_text(encoding="utf-8")
    ci_workflow = (REPO_ROOT / ".github/workflows/ci.yml").read_text(encoding="utf-8")
    release_workflow = (REPO_ROOT / ".github/workflows/release.yml").read_text(encoding="utf-8")

    assert "branding-check" in makefile
    assert "make branding-check" in ci_workflow
    assert "make branding-check" in release_workflow
