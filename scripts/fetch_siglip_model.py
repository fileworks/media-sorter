#!/usr/bin/env python3
"""Download the local SigLIP 2 zero-shot model into a bundle directory.

Used by ``make bundle-siglip`` (and the release workflow) so a frozen MediaSorter
ships the higher-quality offline AI encoder ("Standard"/"Max" tiers) and never
needs to download it at runtime.

Like ``fetch_clip_model.py`` this needs the project venv's Python with the
``local-ai`` extra installed (it uses ``huggingface_hub``). It materialises the
SigLIP 2 vision + text ONNX towers and the tokenizer into ``--dest`` using the
same on-disk layout ``huggingface_hub`` expects, so pointing the runtime
``MEDIASORT_SIGLIP_MODEL_DIR`` at that directory makes the app load it with zero
network access.

The two quantised towers are ~200 MB together — git-ignored build output, never
committed to the repo.
"""

from __future__ import annotations

import argparse
import sys
from pathlib import Path

# Must match app/services/ai/siglip_encoder.py.
REPO = "onnx-community/siglip2-base-patch16-256-ONNX"
FILES = [
    "onnx/vision_model_quantized.onnx",
    "onnx/text_model_quantized.onnx",
    "tokenizer.json",
]


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--dest",
        required=True,
        help="Directory to download the SigLIP model into (used as the HF cache_dir).",
    )
    args = parser.parse_args()

    dest = Path(args.dest)
    dest.mkdir(parents=True, exist_ok=True)

    try:
        from huggingface_hub import hf_hub_download
    except ImportError:
        print(
            "ERROR: huggingface_hub is not installed. Run `make install` first "
            "(it installs the `local-ai` extra).",
            file=sys.stderr,
        )
        return 1

    for filename in FILES:
        print(f"==> Downloading {REPO}/{filename} → {dest}")
        hf_hub_download(REPO, filename, cache_dir=str(dest))
    print(f"✓ SigLIP 2 model ready in {dest}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
