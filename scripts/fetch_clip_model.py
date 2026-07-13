#!/usr/bin/env python3
"""Download the local CLIP zero-shot model into a bundle directory.

Used by ``make bundle-clip`` (and the release workflow) so a frozen MediaSorter
ships the offline AI-tagging model and never needs to download it at runtime.

Unlike ``fetch_ffmpeg.py`` (stdlib-only, runs before the venv exists), this needs
``fastembed`` installed — so it must run with the project venv's Python, AFTER
``make install`` (which installs the ``local-ai`` extra). It simply asks fastembed
to materialise the CLIP image + text encoders into ``--dest``; pointing the
runtime ``cache_dir`` (``MEDIASORT_CLIP_MODEL_DIR``) at that same directory makes
the app load them with zero network access.

The two models together are a few hundred MB — they are git-ignored build output,
never committed to the repo.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Windows defaults stdout to cp1252, which cannot encode the arrows and check
# marks printed below — a decorative character would otherwise raise
# UnicodeEncodeError and fail the Windows release build.
if hasattr(sys.stdout, "reconfigure"):
    sys.stdout.reconfigure(encoding="utf-8", errors="replace")

# Must match LocalClipTagger._IMAGE_MODEL / _TEXT_MODEL in
# app/services/ai/base_tagger.py.
IMAGE_MODEL = "Qdrant/clip-ViT-B-32-vision"
TEXT_MODEL = "Qdrant/clip-ViT-B-32-text"


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dest",
        required=True,
        help="Directory to download the CLIP model into (used as fastembed cache_dir).",
    )
    args = parser.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    try:
        from fastembed import ImageEmbedding, TextEmbedding
    except ImportError:
        print(
            "ERROR: fastembed is not installed. Run `make install` first "
            "(it installs the `local-ai` extra).",
            file=sys.stderr,
        )
        return 1

    print(f"==> Downloading CLIP vision encoder ({IMAGE_MODEL}) → {dest}")
    ImageEmbedding(IMAGE_MODEL, cache_dir=str(dest))
    print(f"==> Downloading CLIP text encoder ({TEXT_MODEL}) → {dest}")
    TextEmbedding(TEXT_MODEL, cache_dir=str(dest))
    print(f"✓ CLIP model ready in {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
