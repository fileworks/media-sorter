---
name: ai-integration
description: Working with the AI tagging and Smart Categorization subsystems — adding providers, modifying confidence logic, or extending label/category handling.
triggers:
  - "AI provider"
  - "new tagger"
  - "confidence threshold"
  - "add category"
  - "CLIP label"
  - "fastembed"
  - "encoder"
  - "smart categorization"
  - "ai tagging"
edges:
  - target: context/ai.md
    condition: always load first — full subsystem reference
  - target: context/decisions.md
    condition: when the change touches sigmoid vs softmax or tagging vs categorization split
  - target: patterns/add-service.md
    condition: when the AI change requires a new service class
last_updated: 2026-06-21
---

# AI Integration

## Context

Load `context/ai.md` before starting any AI work — it contains the full subsystem map, hardware gating logic, provider factory, and scoring math. The two features share `container.encoder` (`VisionEncoder`) and are configured independently.

Key file locations:
- `backend/app/services/ai/base_tagger.py` — `AITagger` interface all taggers implement
- `backend/app/services/ai/ai_tagging_service.py` — local tagger + `build_tagger()` factory
- `backend/app/services/ai/category_classifier_service.py` — Smart Categorization logic
- `backend/app/services/ai/clip_embedder.py` — CLIP embedding logic wrapping fastembed
- `backend/app/services/ai/hardware.py` — `HardwareProfile.probe()` tier detection
- `backend/app/services/ai/encoder_factory.py` — `build_encoder()` that creates `VisionEncoder | None`
- `backend/app/core/config.py` — all `ai_tagging_*` and `categorize_*` fields

## Task: Add a Cloud AI Tagging Provider

### Steps

1. Create a new file in `backend/app/services/ai/` (e.g. named after your provider) inheriting from `AITagger`:
   ```python
   from app.services.ai.base_tagger import AITagger
   from pathlib import Path

   class MyProviderTagger(AITagger):
       def __init__(self, api_key: str, confidence_threshold: float) -> None:
           self._api_key = api_key
           self._threshold = confidence_threshold

       def tag(self, file_path: Path) -> list[str]:
           # synchronous — already in a worker thread
           response = _call_my_provider_api(file_path, self._api_key)
           return [t.label for t in response.tags if t.confidence >= self._threshold]
   ```

2. Register in `build_tagger()` in `ai_tagging_service.py`:
   ```python
   elif config.ai_tagging_provider == "my_provider":
       from app.services.ai.my_provider_tagger import MyProviderTagger
       return MyProviderTagger(
           api_key=config.ai_tagging_api_key or "",
           confidence_threshold=config.ai_tagging_confidence_threshold,
       )
   ```

3. Add the provider name to the `Config.ai_tagging_provider` docstring in `backend/app/core/config.py`.

4. Add a config validation case in `POST /api/config/validate` if the provider requires specific fields (e.g., `api_key` must be non-empty when provider = "my_provider").

### Gotchas

- `tag()` **must be synchronous** — it runs inside `asyncio.to_thread` in `SortingService._process_file`. Adding `async def` or `await` here will break the contract.
- Use `config.ai_tagging_api_key`, `config.ai_tagging_api_secret`, and `config.ai_tagging_endpoint` — these three fields are the shared cloud credential shape. Do not add new config fields for credentials unless the shape genuinely differs.
- Never hit live APIs in tests — mock at the tagger class level, not at the HTTP level.
- Best-effort: any exception in `tag()` should be caught by the caller (`AITaggingService`) and logged as a warning, yielding `[]`. Verify the caller already has this guard before relying on it.

### Verify

- [ ] `tag()` is synchronous, not `async def`
- [ ] New provider registered in `build_tagger()` factory
- [ ] Tests mock the tagger; no live API calls
- [ ] Failure path yields `[]` not an exception (confirm caller guard exists)

## Task: Modify Confidence Thresholds or Scoring

### Steps

For **AI tagging** (sigmoid, per-label):
- Threshold field: `Config.ai_tagging_confidence_threshold` (default 0.5, range 0–1)
- Scoring: `sigmoid(slope · (cosine(label) − cosine(background)))` in `clip_embedder.py`
- Changing `slope` changes how steeply probability rises around the background floor — higher slope → sharper discrimination

For **Smart Categorization** (anchor-relative softmax):
- Threshold field: `Config.categorize_confidence_threshold` (default 0.55, range 0.50–0.99)
- Margin field: `Config.categorize_min_margin` (default 0.15, range 0.0–0.50)
- Temperature: ~40 (hardcoded in `CategoryClassifierService`, intentionally NOT 100)
- Both gates must pass; files that fail go to an `_uncategorized` subfolder

### Gotchas

- **Do not raise temperature to 100** for categorization — that's the root cause of the original mis-classify bug (softmax saturated near 1.0, gate became meaningless). See `context/decisions.md`.
- `CATEGORIZE_THRESHOLD_MIN`, `CATEGORIZE_THRESHOLD_MAX`, `CATEGORIZE_MIN_MARGIN_MIN`, `CATEGORIZE_MIN_MARGIN_MAX`, and `PERCEPTUAL_THRESHOLD_MIN`/`PERCEPTUAL_THRESHOLD_MAX` are defined as constants in `backend/app/core/config.py` and used by both the backend validator and the frontend sliders — keep them in sync.

## Task: Extend the Label Vocabulary or Category List

### Steps

1. For **AI tagging labels** — add to `Config.ai_tagging_labels` default list in `backend/app/core/config.py`. Each label is a natural language phrase scored by the CLIP zero-shot model.
2. For **Smart Categorization categories** — add to `Config.categorize_categories` default list. Each category is also a user-visible folder name, so it must survive `path_utils.sanitize_path_segment()` (no path separators, `..`, illegal chars, Windows device names).
3. Run `path_utils.sanitize_path_segment(name)` manually to verify any new category name is safe before adding it as a default.

### Gotchas

- More categories lower the top-1 softmax probability per category (probability mass spreads). If the default confidence threshold (0.55) starts failing too many files to `_uncategorized`, lower it or reduce the number of default categories.
- `CATEGORIZE_SANITY_MAX = 1000` is a pathological ceiling, not a practical limit.
- Category names are sanitized at both validation (`POST /api/config/validate`) and path-build time — do not skip sanitization even in tests.

## Update Scaffold
- [ ] Update `.mex/ROUTER.md` "Current Project State" if what's working/not built has changed
- [ ] Update `context/ai.md` if a new provider, model tier, or scoring change is significant
- [ ] Update `context/decisions.md` if a scoring design decision changed
