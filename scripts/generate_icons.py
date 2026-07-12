#!/usr/bin/env python3
"""
Generate MediaSorter app icons in all sizes required by Tauri 1.5.

Usage:
    python scripts/generate_icons.py

Requires: pip install pillow
Output:   frontend/src-tauri/icons/  (all sizes + ico)
"""

from __future__ import annotations

from pathlib import Path

from PIL import Image, ImageDraw

ICONS_DIR = Path(__file__).parent.parent / "frontend" / "src-tauri" / "icons"
ICONS_DIR.mkdir(parents=True, exist_ok=True)

# Brand colours
BG = (37, 99, 235)  # #2563EB — blue-600
BG_DARK = (29, 78, 216)  # #1D4ED8 — blue-700
WHITE = (255, 255, 255)

SIZES = [32, 128, 256, 512, 1024]


def draw_icon(size: int) -> Image.Image:
    """Draw the MediaSorter icon at the given square pixel size."""
    img = Image.new("RGBA", (size, size), (0, 0, 0, 0))
    draw = ImageDraw.Draw(img)

    # — Background rounded rectangle —
    r = int(size * 0.22)
    draw.rounded_rectangle([0, 0, size - 1, size - 1], radius=r, fill=BG)

    p = size / 512  # scale factor

    # — Folder body (white rounded rect) —
    fx0, fy0 = int(80 * p), int(160 * p)
    fx1, fy1 = int(432 * p), int(380 * p)
    draw.rounded_rectangle([fx0, fy0, fx1, fy1], radius=int(24 * p), fill=WHITE)

    # — Folder tab (top-left nub) —
    tx0, ty0 = int(80 * p), int(130 * p)
    tx1, ty1 = int(220 * p), int(165 * p)
    draw.rounded_rectangle([tx0, ty0, tx1, ty1], radius=int(14 * p), fill=WHITE)

    # — Sort arrows (↕) centred in the folder —
    cx = size // 2
    arrow_top_tip = int(210 * p)
    arrow_bot_tip = int(330 * p)
    shaft_half = int(18 * p)
    head_half = int(36 * p)
    head_h = int(48 * p)
    mid = (arrow_top_tip + arrow_bot_tip) // 2

    arrow_colour = BG  # blue arrows on white folder

    # Up arrow
    draw.polygon(
        [
            (cx, arrow_top_tip),
            (cx - head_half, arrow_top_tip + head_h),
            (cx - shaft_half, arrow_top_tip + head_h),
            (cx - shaft_half, mid - int(6 * p)),
            (cx + shaft_half, mid - int(6 * p)),
            (cx + shaft_half, arrow_top_tip + head_h),
            (cx + head_half, arrow_top_tip + head_h),
        ],
        fill=arrow_colour,
    )

    # Down arrow
    draw.polygon(
        [
            (cx, arrow_bot_tip),
            (cx - head_half, arrow_bot_tip - head_h),
            (cx - shaft_half, arrow_bot_tip - head_h),
            (cx - shaft_half, mid + int(6 * p)),
            (cx + shaft_half, mid + int(6 * p)),
            (cx + shaft_half, arrow_bot_tip - head_h),
            (cx + head_half, arrow_bot_tip - head_h),
        ],
        fill=arrow_colour,
    )

    # — Small calendar badge (bottom-right of folder) —
    bx0, by0 = int(310 * p), int(310 * p)
    bx1, by1 = int(430 * p), int(400 * p)
    draw.rounded_rectangle([bx0, by0, bx1, by1], radius=int(12 * p), fill=BG_DARK)

    # Calendar lines (white)
    lw = max(1, int(4 * p))
    ly1 = by0 + int(28 * p)
    # horizontal divider
    draw.rectangle([bx0 + int(8 * p), ly1, bx1 - int(8 * p), ly1 + lw], fill=WHITE)
    # two rings at top
    for rx in (bx0 + int(22 * p), bx1 - int(22 * p)):
        draw.ellipse(
            [rx - int(6 * p), by0 - int(8 * p), rx + int(6 * p), by0 + int(10 * p)],
            fill=WHITE,
        )

    return img


def main() -> None:
    print("Generating MediaSorter icons…")

    # Generate all PNG sizes
    for size in SIZES:
        img = draw_icon(size)
        out = ICONS_DIR / f"{size}x{size}.png"
        img.save(out, "PNG")
        print(f"  ✓  {out.name}")

    # 32x32@2x = 64px
    img64 = draw_icon(64)
    out64 = ICONS_DIR / "32x32@2x.png"
    img64.save(out64, "PNG")
    print(f"  ✓  {out64.name}")

    # 128x128@2x = 256px (same as 256x256)
    img256 = draw_icon(256)
    out128_2x = ICONS_DIR / "128x128@2x.png"
    img256.save(out128_2x, "PNG")
    print(f"  ✓  {out128_2x.name}")

    # icon.png (512px) used by Tauri for generic icon
    img512 = draw_icon(512)
    (ICONS_DIR / "icon.png").unlink(missing_ok=True)
    img512.save(ICONS_DIR / "icon.png", "PNG")
    print(f"  ✓  icon.png")

    # Windows ICO (multi-size)
    ico_sizes = [16, 24, 32, 48, 64, 128, 256]
    ico_imgs = [draw_icon(s) for s in ico_sizes]
    ico_path = ICONS_DIR / "icon.ico"
    ico_imgs[0].save(
        ico_path,
        format="ICO",
        sizes=[(s, s) for s in ico_sizes],
        append_images=ico_imgs[1:],
    )
    print(f"  ✓  icon.ico")

    print("")
    print("✓ All icons generated in", ICONS_DIR)
    print("")
    print("Next: run  make install  then  make release  to rebuild with the new icon.")


if __name__ == "__main__":
    main()
