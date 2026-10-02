#!/usr/bin/env python3
"""Generate and verify MediaSorter branding from one approved source image."""

from __future__ import annotations

import argparse
import hashlib
import os
import tempfile
from collections.abc import Callable
from pathlib import Path

from PIL import Image, ImageDraw

REPO_ROOT = Path(__file__).resolve().parent.parent
CANONICAL = Path("branding/app-icon.png")
# The approved Kontur folder mark is inset on a warm app tile, and that tile is
# inset within the canvas, on Apple's documented 824/1024 macOS grid.
#
# An earlier revision used 744/1024, on the reasoning that macOS composites no
# mask over an `.icns` and so a smaller tile is a smaller icon in the dock.
# That is no longer true. macOS 26 normalises every legacy `.icns` into the
# standard squircle plate, scaling the artwork's opaque bounds to 824/1024
# whatever they were authored at; measured through `NSWorkspace.icon(forFile:)`
# on 26.6, this app and Mail, Notes, Terminal and VS Code all render their
# plate at exactly 412px of 512. The tile ratio therefore no longer changes the
# icon's size on macOS at all — it only decides whether macOS upscales to reach
# the grid, and what Windows and Linux, which do not normalise, are handed.
#
# What *is* visible on macOS is the mark's share of that fixed plate, and it is
# set in the SVG (`scale(1.45)`), not here. The tile check below still matters:
# it is what stops the next adopted blob from restoring a full-bleed slab.
#
# The three numbers below are the contract. They are asserted against the
# rendered canonical PNG on every `make branding` and `make branding-check`,
# because the icon has now shipped at the wrong size several times over: a
# geometry that lives only inside an opaque approved blob drifts silently and
# nothing catches it. See `branding/app-icon.svg`, the drawing this PNG is
# rendered from. The favicon keeps using the tighter 32-unit drawing directly.
TILE_RATIO = 824 / 1024
TILE_TOLERANCE_PX = 4
CENTER_TOLERANCE_PX = 3
APPROVED_SOURCE_SHA256 = (
    "94cc991f8566656602b40148e88f178c40f1f9a03e31284816343d5be6b176ad"
)
CANONICAL_SIZE = (1024, 1024)

PNG_ICONS = {
    "frontend/src-tauri/icons/32x32.png": 32,
    "frontend/src-tauri/icons/128x128.png": 128,
    "frontend/src-tauri/icons/128x128@2x.png": 256,
    "frontend/src-tauri/icons/icon.png": 512,
    "frontend/src-tauri/icons/Square30x30Logo.png": 30,
    "frontend/src-tauri/icons/Square44x44Logo.png": 44,
    "frontend/src-tauri/icons/Square71x71Logo.png": 71,
    "frontend/src-tauri/icons/Square89x89Logo.png": 89,
    "frontend/src-tauri/icons/Square107x107Logo.png": 107,
    "frontend/src-tauri/icons/Square142x142Logo.png": 142,
    "frontend/src-tauri/icons/Square150x150Logo.png": 150,
    "frontend/src-tauri/icons/Square284x284Logo.png": 284,
    "frontend/src-tauri/icons/Square310x310Logo.png": 310,
    "frontend/src-tauri/icons/StoreLogo.png": 50,
}
ICO_SIZES = ((16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256))
ICNS_SIZES = (32, 64, 128, 256, 512, 1024)
INSTALLER_IMAGES = {
    "frontend/src-tauri/installer/nsis-header.bmp": ("BMP", (150, 57)),
    "frontend/src-tauri/installer/nsis-sidebar.bmp": ("BMP", (164, 314)),
    "frontend/src-tauri/installer/wix-banner.bmp": ("BMP", (493, 58)),
    "frontend/src-tauri/installer/wix-dialog.bmp": ("BMP", (493, 312)),
    "frontend/src-tauri/installer/dmg-background.png": ("PNG", (660, 400)),
}
GENERATED_PATHS = (
    tuple(PNG_ICONS)
    + (
        "frontend/src-tauri/icons/icon.ico",
        "frontend/src-tauri/icons/icon.icns",
    )
    + tuple(INSTALLER_IMAGES)
)

ORANGE = (255, 91, 0)
ORANGE_LIGHT = (255, 153, 10)
CREAM = (250, 247, 240)
WHITE = (255, 255, 255)
INK = (73, 48, 33)


class BrandingError(RuntimeError):
    """Raised when canonical or generated branding violates its contract."""


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def _bounding_box(
    image: Image.Image, predicate: Callable[[tuple[int, int, int, int]], bool]
) -> tuple[int, int, int, int]:
    pixels = image.load()
    width, height = image.size
    left, top, right, bottom = width, height, -1, -1
    for y in range(height):
        for x in range(width):
            if predicate(pixels[x, y]):
                left = min(left, x)
                right = max(right, x)
                top = min(top, y)
                bottom = max(bottom, y)
    if right < 0:
        raise BrandingError("canonical branding source has no visible content")
    return left, top, right, bottom


def _validate_geometry(path: Path, image: Image.Image) -> None:
    """Assert the tile inset and the mark's centring, not just the file's hash.

    macOS 26 rescales a legacy `.icns` onto the 824/1024 plate for us, so this
    is no longer what decides the icon's size in the dock. It is still what
    Windows and Linux are handed verbatim, what keeps macOS from upscaling to
    reach that plate, and what stops the next adopted blob from quietly
    restoring a full-bleed slab.
    """
    canvas = image.size[0]
    tile = _bounding_box(image, lambda pixel: pixel[3] > 128)
    ink = _bounding_box(
        image, lambda pixel: pixel[3] > 128 and sum(pixel[:3]) < 500
    )
    expected_edge = round(canvas * TILE_RATIO)
    for axis, low, high in (("width", tile[0], tile[2]), ("height", tile[1], tile[3])):
        edge = high - low + 1
        if abs(edge - expected_edge) > TILE_TOLERANCE_PX:
            raise BrandingError(
                f"{path}: tile {axis} is {edge}px of {canvas}px, expected "
                f"{expected_edge}px (TILE_RATIO = {TILE_RATIO:.4f}); this is "
                "Apple's documented macOS grid and the size Windows and Linux "
                "are handed unaltered"
            )
    for label, box, container in (
        ("tile", tile, (0, 0, canvas - 1, canvas - 1)),
        ("mark", ink, tile),
    ):
        for axis, index in (("horizontally", 0), ("vertically", 1)):
            offset = (box[index] + box[index + 2]) - (
                container[index] + container[index + 2]
            )
            if abs(offset / 2) > CENTER_TOLERANCE_PX:
                raise BrandingError(
                    f"{path}: the {label} sits {abs(offset / 2):.1f}px off centre "
                    f"{axis}; it must be centred within {CENTER_TOLERANCE_PX}px"
                )


def _validate_canonical(path: Path) -> Image.Image:
    if not path.is_file():
        raise BrandingError(
            f"canonical branding source is missing: {path}; "
            "adopt the approved source before generating assets"
        )
    if _sha256(path) != APPROVED_SOURCE_SHA256:
        raise BrandingError(
            f"{path} is not the explicitly approved padded artwork; "
            "render it from branding/app-icon.svg and update "
            "APPROVED_SOURCE_SHA256"
        )
    with Image.open(path) as opened:
        if (
            opened.format != "PNG"
            or opened.size != CANONICAL_SIZE
            or opened.mode != "RGBA"
        ):
            raise BrandingError(
                f"{path} must be a 1024x1024 RGBA PNG, got "
                f"{opened.format} {opened.mode} {opened.size}"
            )
        source = opened.copy()
    _validate_geometry(path, source)
    return source


def _atomic_bytes(path: Path, payload: bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    temporary.write_bytes(payload)
    os.replace(temporary, path)


def adopt_source(candidate: Path, destination_root: Path = REPO_ROOT) -> None:
    candidate = candidate.resolve()
    _validate_canonical(candidate)
    canonical = destination_root / CANONICAL
    _atomic_bytes(canonical, candidate.read_bytes())


def _atomic_image(
    path: Path, image: Image.Image, image_format: str, **options: object
) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    temporary = path.with_name(f".{path.name}.{os.getpid()}.tmp")
    try:
        image.save(temporary, format=image_format, **options)
        os.replace(temporary, path)
    finally:
        temporary.unlink(missing_ok=True)


def _icon(source: Image.Image, size: int) -> Image.Image:
    return source.resize((size, size), Image.Resampling.LANCZOS)


def _vertical_gradient(
    size: tuple[int, int], top: tuple[int, int, int], bottom: tuple[int, int, int]
) -> Image.Image:
    width, height = size
    image = Image.new("RGB", size)
    pixels = image.load()
    denominator = max(1, height - 1)
    for y in range(height):
        weight = y / denominator
        color = tuple(
            round(start + (end - start) * weight) for start, end in zip(top, bottom)
        )
        for x in range(width):
            pixels[x, y] = color
    return image


def _paste_icon(
    canvas: Image.Image, source: Image.Image, box: tuple[int, int, int, int]
) -> None:
    left, top, right, bottom = box
    size = min(right - left, bottom - top)
    icon = _icon(source, size)
    x = left + (right - left - size) // 2
    y = top + (bottom - top - size) // 2
    canvas.paste(icon, (x, y), icon)


def _nsis_header(source: Image.Image) -> Image.Image:
    canvas = _vertical_gradient((150, 57), WHITE, CREAM)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 54, 149, 56), fill=ORANGE)
    _paste_icon(canvas, source, (96, 3, 150, 55))
    return canvas


def _nsis_sidebar(source: Image.Image) -> Image.Image:
    canvas = _vertical_gradient((164, 314), ORANGE_LIGHT, ORANGE)
    draw = ImageDraw.Draw(canvas)
    draw.ellipse((-65, 200, 110, 375), fill=(255, 126, 8))
    draw.ellipse((80, -45, 210, 85), fill=(255, 174, 34))
    _paste_icon(canvas, source, (18, 79, 146, 207))
    return canvas


def _wix_banner(source: Image.Image) -> Image.Image:
    canvas = _vertical_gradient((493, 58), WHITE, CREAM)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 55, 492, 57), fill=ORANGE)
    _paste_icon(canvas, source, (437, 3, 491, 55))
    return canvas


def _wix_dialog(source: Image.Image) -> Image.Image:
    canvas = _vertical_gradient((493, 312), WHITE, CREAM)
    sidebar = _nsis_sidebar(source).resize((164, 312), Image.Resampling.LANCZOS)
    canvas.paste(sidebar, (0, 0))
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((164, 0, 167, 311), fill=(255, 213, 167))
    return canvas


def _dmg_background(source: Image.Image) -> Image.Image:
    canvas = _vertical_gradient((660, 400), WHITE, CREAM)
    draw = ImageDraw.Draw(canvas)
    draw.rectangle((0, 0, 659, 7), fill=ORANGE)
    _paste_icon(canvas, source, (288, 18, 372, 102))

    # Finder places the app and Applications icons at x=180 and x=480. Keep the
    # middle clear except for a directional cue that cannot overlap either icon.
    draw.rounded_rectangle((275, 181, 385, 219), radius=19, fill=(255, 232, 205))
    draw.line((294, 200, 358, 200), fill=ORANGE, width=8)
    draw.polygon(((358, 184), (380, 200), (358, 216)), fill=ORANGE)
    draw.ellipse((167, 187, 193, 213), outline=(255, 196, 132), width=3)
    draw.ellipse((467, 187, 493, 213), outline=(255, 196, 132), width=3)
    return canvas


def _generate_into(destination_root: Path, source: Image.Image) -> None:
    for relative, size in PNG_ICONS.items():
        _atomic_image(
            destination_root / relative, _icon(source, size), "PNG", optimize=False
        )

    icon_dir = destination_root / "frontend/src-tauri/icons"
    _atomic_image(icon_dir / "icon.ico", source, "ICO", sizes=ICO_SIZES)
    icns_images = [_icon(source, size) for size in ICNS_SIZES]
    _atomic_image(
        icon_dir / "icon.icns",
        icns_images[-1],
        "ICNS",
        append_images=icns_images[:-1],
    )

    builders: dict[str, Callable[[Image.Image], Image.Image]] = {
        "frontend/src-tauri/installer/nsis-header.bmp": _nsis_header,
        "frontend/src-tauri/installer/nsis-sidebar.bmp": _nsis_sidebar,
        "frontend/src-tauri/installer/wix-banner.bmp": _wix_banner,
        "frontend/src-tauri/installer/wix-dialog.bmp": _wix_dialog,
        "frontend/src-tauri/installer/dmg-background.png": _dmg_background,
    }
    for relative, builder in builders.items():
        image_format, _ = INSTALLER_IMAGES[relative]
        _atomic_image(destination_root / relative, builder(source), image_format)


def generate_assets(destination_root: Path = REPO_ROOT) -> None:
    source = _validate_canonical(destination_root / CANONICAL)
    _generate_into(destination_root, source)


def _validate_generated(
    path: Path, expected_format: str, expected_size: tuple[int, int] | None
) -> None:
    try:
        with Image.open(path) as image:
            if image.format != expected_format:
                raise BrandingError(
                    f"{path} has format {image.format}, expected {expected_format}"
                )
            if expected_size is not None and image.size != expected_size:
                raise BrandingError(
                    f"{path} has size {image.size}, expected {expected_size}"
                )
            if expected_format == "BMP" and image.mode != "RGB":
                raise BrandingError(f"{path} must be an RGB bitmap, got {image.mode}")
            if expected_format == "ICO":
                sizes = image.ico.sizes()
                if sizes != set(ICO_SIZES):
                    raise BrandingError(
                        f"{path} contains ICO sizes {sorted(sizes)}, "
                        f"expected {list(ICO_SIZES)}"
                    )
    except (OSError, SyntaxError) as error:
        raise BrandingError(
            f"cannot read generated branding asset {path}: {error}"
        ) from error


def _same_image_content(actual_path: Path, expected_path: Path) -> bool:
    """Compare decoded image content without depending on encoder byte output."""
    if not actual_path.is_file() or not expected_path.is_file():
        return False
    try:
        with Image.open(actual_path) as actual, Image.open(expected_path) as expected:
            if (
                actual.format != expected.format
                or actual.mode != expected.mode
                or actual.size != expected.size
            ):
                return False
            if actual.format == "ICO":
                actual_sizes = actual.ico.sizes()
                expected_sizes = expected.ico.sizes()
                if actual_sizes != expected_sizes:
                    return False
                return all(
                    actual.ico.getimage(size).convert("RGBA").tobytes()
                    == expected.ico.getimage(size).convert("RGBA").tobytes()
                    for size in actual_sizes
                )
            if actual.format == "ICNS":
                actual_sizes = set(actual.info.get("sizes", []))
                expected_sizes = set(expected.info.get("sizes", []))
                if actual_sizes != expected_sizes:
                    return False
                return all(
                    actual.icns.getimage(size).convert("RGBA").tobytes()
                    == expected.icns.getimage(size).convert("RGBA").tobytes()
                    for size in actual_sizes
                )
            return actual.tobytes() == expected.tobytes()
    except (OSError, SyntaxError):
        return False


def check_assets(source_root: Path = REPO_ROOT) -> None:
    source = _validate_canonical(source_root / CANONICAL)
    with tempfile.TemporaryDirectory(prefix="mediasorter-branding-") as temporary:
        expected_root = Path(temporary)
        _generate_into(expected_root, source)
        drifted: list[str] = []
        for relative in GENERATED_PATHS:
            actual = source_root / relative
            expected = expected_root / relative
            if not _same_image_content(actual, expected):
                drifted.append(relative)
        if drifted:
            preview = "\n".join(f"  - {path}" for path in drifted)
            raise BrandingError(
                "generated branding is missing or stale:\n"
                f"{preview}\n"
                "run `make branding` and commit the regenerated assets"
            )

    for relative, size in PNG_ICONS.items():
        _validate_generated(source_root / relative, "PNG", (size, size))
    _validate_generated(source_root / "frontend/src-tauri/icons/icon.ico", "ICO", None)
    _validate_generated(
        source_root / "frontend/src-tauri/icons/icon.icns", "ICNS", None
    )
    for relative, (image_format, size) in INSTALLER_IMAGES.items():
        _validate_generated(source_root / relative, image_format, size)


def _parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(description=__doc__)
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument(
        "--check",
        action="store_true",
        help="fail if tracked derivatives differ from deterministic output",
    )
    mode.add_argument(
        "--adopt",
        type=Path,
        metavar="APPROVED_PNG",
        help="copy the explicitly approved v2 padded candidate to the canonical path",
    )
    return parser.parse_args()


def main() -> int:
    args = _parse_args()
    try:
        if args.adopt is not None:
            adopt_source(args.adopt)
            generate_assets()
            print(f"Adopted approved source as {CANONICAL}")
            print(f"Generated {len(GENERATED_PATHS)} branding assets")
        elif args.check:
            check_assets()
            print(f"Branding is fresh: {len(GENERATED_PATHS)} generated assets")
        else:
            generate_assets()
            print(f"Generated {len(GENERATED_PATHS)} branding assets from {CANONICAL}")
    except BrandingError as error:
        print(f"branding error: {error}", file=os.sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
