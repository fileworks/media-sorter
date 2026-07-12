---
name: ai
description: AI content tagging and Smart Categorization subsystems — CLIP encoder, tagger interface, hardware gating, confidence logic, and known gotchas. Load when working on AI features.
triggers:
  - "AI tagging"
  - "smart categorization"
  - "CLIP"
  - "fastembed"
  - "confidence"
  - "category classifier"
  - "encoder"
  - "sigmoid"
  - "softmax"
  - "local AI"
edges:
  - target: context/architecture.md
    condition: when understanding where AI fits in the overall sort pipeline
  - target: context/decisions.md
    condition: when understanding why sigmoid vs softmax or tagging vs categorization were split
  - target: patterns/ai-integration.md
    condition: when adding or modifying AI features
last_updated: 2026-06-23
---

# AI Subsystem

## Two Features, One Shared Encoder

MediaSorter has two independent AI opt-in features that share a single `VisionEncoder` instance:

| Feature | Config flag | What it does | Runs in preview? |
|---------|-------------|--------------|-----------------|
| **AI content tagging** | `ai_tagging_enabled` | Writes descriptive keywords into file EXIF / sidecar | No — avoids quota burn on dry runs |
| **Smart Categorization** | `categorize_enabled` | Routes each file into a topic subfolder under the date hierarchy | Yes — placement affects dry-run output |

Both pull `container.encoder` from `ServiceContainer`. The encoder is built once via `encoder_factory.build_encoder(config, hardware_profile)` and cached. If the encoder is `None` (hardware tier = "off", or fastembed not installed), both services gracefully skip — no error, no tags, no category.

## Encoder and Hardware Gating

`HardwareProfile.probe()` (`backend/app/services/ai/hardware.py`) inspects CPU count, available RAM, and ONNX execution providers (CUDA, CoreML, DirectML) to select a model tier:

| Tier | When | Model | Encoder class |
|------|------|-------|---------------|
| `off` | < 4 CPU or < 3.5 GB RAM | None — AI skipped | — |
| `lite` | Low-end (4–7 CPU, CPU-only) | CLIP ViT-B/32 (fastembed) | `ClipEmbedder` |
| `standard` | ≥ 8 CPU or ≥ 7.5 GB RAM | **SigLIP 2 base/16 @256** | `SiglipOnnxEncoder` |
| `max` | Accelerator EP present | **SigLIP 2 base/16 @256** (GPU EP) | `SiglipOnnxEncoder` |

`Config.ai_model_tier` defaults to `"auto"` (let `HardwareProfile` decide). Override with `"off"`, `"lite"`, `"standard"`, or `"max"`.
`Config.ai_allow_gpu` (default `True`) controls whether GPU execution providers are tried (CoreML/CUDA/DirectML).

**SigLIP 2 (`siglip_encoder.py`)** — onnxruntime runs the vision+text towers; the Gemma tokenizer is auto-downloaded from the `tokenizers` Python library (external); model weights lazy-download from HuggingFace Hub (external, model ID: onnx-community/siglip2-base-patch16-256-ONNX, ~100 MB/tower quantised) or load from optional bundled directory (via `MEDIASORT_SIGLIP_MODEL_DIR` env var or `make bundle-siglip`). Image preprocessing: resize 256² bilinear, rescale 1/255, normalise mean/std 0.5. Text: lower-case, append `<eos>`, pad to 64. I/O names resolved from the loaded graph (uses `pooler_output`). **Falls back to CLIP** when onnxruntime/weights are unavailable — a sort is never broken.

**SigLIP calibration:** cosines sit in a *narrower, lower* band than CLIP (matches ≈0.05–0.14 vs CLIP's ≈0.20–0.26), so SigLIP needs a HIGHER softmax temperature, not lower — `tagger_slope=40`, `categorize_scale=60` (CLIP: 100/40). These are empirical, not yet benchmark-swept.

**Changing the tier at runtime:** `ServiceContainer.set_config` drops the cached encoder + AI services when `ai_model_tier`/`ai_allow_gpu` change, so they rebuild (lazily, in a worker thread) with the new model.

**Known gotcha:** fastembed 0.8.0 has a broken `jina-clip-v1` text encoder; the Lite/CLIP tier uses `ViT-B-32` only. Do not attempt `jina-clip-v1`.

## AI Tagging (`AITaggingService`)

- Provider: `local` (default, offline CLIP) or cloud (`azure_vision`, `imagga`, `google_cloud_vision`)
- Factory: `build_tagger(config)` in `backend/app/services/ai/ai_tagging_service.py` returns the right `AITagger` subclass
- All taggers implement the `AITagger` interface (`backend/app/services/ai/base_tagger.py`): `tag(file_path) -> list[str]`
- Taggers are **synchronous** — `_process_file` already runs in a worker thread (`asyncio.to_thread`), so blocking ONNX/HTTP calls need no event-loop gymnastics
- **Scoring:** `sigmoid(slope · (cosine(label) − cosine(background)))` — each label is independent; co-occurring tags don't lose probability to each other
- **Threshold:** `Config.ai_tagging_confidence_threshold` (default 0.5) is the per-label sigmoid floor
- **Tag embedding:** written into `XPKeywords` EXIF for JPEG/TIFF; `keywords` stream tag for video; `.xmp` sidecar for everything else
- **Max tags:** `Config.ai_tagging_max_tags` (default 10) caps the number written per file

## Smart Category Suggestions (`CategorySuggestionService`)

A one-shot helper (`backend/app/services/ai/category_suggestion_service.py`) that proposes category names by analysing the user's actual photos:

1. **Sample** — walks source dir (respects `recursive_scan`, `max_recursion_depth`, `exclude_patterns`), collects images, shuffles, takes up to 150
2. **Embed** — calls `encoder.embed_image()` on each (synchronous; route wraps in `asyncio.to_thread`)
3. **Cluster** — pure-numpy k-means (Lloyd's, 15 iter), clamped so k ≤ n; centroids L2-normalised after each iteration
4. **Match** — cosine-argmax against a 60-word `_VOCABULARY` (nature, travel, food, animals, …); vocab embeddings cached in `self._vocab_cache` per encoder instance
5. **Deduplicate** — seen set; returns `list[str]` of unique labels (may be shorter than requested k)

**Route:** `POST /api/ai/suggest-categories` (body `{n_categories: int 2–12}`)
- 503 when `container.encoder is None` (tier=off / fastembed missing)
- 422 for out-of-range `n_categories` (Pydantic `ge=2, le=12`)
- Registered on `ServiceContainer`; invalidated alongside other AI services in `set_config` encoder-changed block

**Frontend:** `useAiSuggestions` hook (`frontend/src/hooks/useAiSuggestions.ts`) + "Suggest from photos" link above `CategoryTagsInput` in `FoldersSection`; accept-chip UI below input (click to add, × to dismiss); `api.suggestCategories()` in `api.ts`.

## Smart Categorization (`CategoryClassifierService`)

- **Local CLIP only** — cloud taxonomies can't map to the user's custom folder names
- **Scoring:** softmax over (user categories + background anchor phrases) at temperature ≈40 (not the shared CLIP logit scale of 100, which saturates the distribution)
- **Dual confidence gate:** file is categorized only when:
  - top-1 probability ≥ `Config.categorize_confidence_threshold` (default 0.55), **AND**
  - top-1 − top-2 margin ≥ `Config.categorize_min_margin` (default 0.15)
  - Otherwise → an `_uncategorized` subfolder (still dated and sorted, just not topic-binned)
- **Mutual exclusion:** `categorize_enabled` and `preserve_subfolders` cannot both be `True` — both impose structure under the date folder. The UI disables the conflicting toggle; the backend enforces precedence deterministically.
- **Category name safety:** every category name passes through `path_utils.sanitize_path_segment()` at validation time AND build time — strips path separators, `..`, illegal chars, and Windows reserved device names.
- **Stacks with camera subfolder:** `…/Y/M/D/<category>/<camera>/` is valid.

## Adding a New Cloud AI Provider

1. Create a new class in `backend/app/services/ai/` inheriting from `AITagger` (`base_tagger.py`)
2. Implement `tag(file_path: Path) -> list[str]` synchronously
3. Register it in `build_tagger()` in `ai_tagging_service.py`
4. Add the provider name to `Config.ai_tagging_provider` docstring and to the config validation
5. Write unit tests with a mocked HTTP client — never hit live APIs in tests

## Testing AI Code

- Tests that require fastembed use `pytest.importorskip("fastembed")` — skip cleanly in CI
- Mock the tagger at the `AITaggingService` level, not at the ONNX/HTTP level
- Test the confidence gate logic with synthetic cosine scores, not real model outputs
