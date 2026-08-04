<!-- scope: ONLY legacy/anti-patterns with the replacement THIS REPO uses — never suggest these -->

## Python Backend

❌ `datetime.utcnow()` ✅ `datetime.now(timezone.utc)` (utcnow is deprecated in Python
3.12+)

❌ Blocking I/O (disk, subprocess, PIL, sqlite, model inference) directly in an `async
def` route ✅ `await asyncio.to_thread(sync_core, ...)` — services expose sync cores +
thin async wrappers

❌ Synchronous routes (`def` instead of `async def`) ✅ `async def` routes everywhere;
offload blocking work per the rule above

❌ Bare `Request` injection to reach `app.state` ✅ `ContainerDep` / `ConfigDep` from
`app/api/deps.py`

❌ `raise HTTPException(status_code=..., detail=...)` ✅ Subclass `MediaSortException`
(`app/core/exceptions.py`) → uniform `{"error","code","details"}` envelope

❌ Querying SQLite from a route, or holding one long-lived connection ✅
`DatabaseManager._connect()` per operation, called from a sync core via
`asyncio.to_thread`

❌ `ALTER TABLE … DROP/RENAME COLUMN`, or any destructive migration ✅ Additive `ADD
COLUMN` in `DatabaseManager.init_schema()`, wrapped in `suppress(Exception)` (idempotent
re-runs)

❌ Hard-cancelling background work (`asyncio.Task.cancel()`) from an API route ✅
Cooperative cancel: set `task.cancel_event`; loops break between files and persist
partial results (hard cancel only in `TaskManager.shutdown()`)

❌ Returning raw internal objects from a route ✅ Pydantic `response_model` — or one of
the *documented* dict blobs (config/report/preview)

❌ Global mutation of `PIL.ImageFile.LOAD_TRUNCATED_IMAGES` ✅ Scope it: save, set,
restore in `finally` (see `RepairService.repair_image`)

❌ Comparing/parsing dates from EXIF without sentinel checks ✅ Route through
`DateExtractionService` (camera-reset sentinels, future-date + pre-1990 rejection)

## AI / Models

❌ `jina-clip-v1` via fastembed 0.8.0 ✅ Broken text encoder (model silently stuck at
ViT-B/32) — use the default CLIP ViT-B/32 (Lite) or SigLIP 2 (Standard/Max)

❌ `onnx-clip` package ✅ Conflicts with the repo's pillow pin — `fastembed` provides the
CLIP towers

❌ Hardcoding scoring constants in tagger/categoriser code ✅ `tagger_slope` /
`categorize_scale` travel with the encoder (`VisionEncoder` properties) — CLIP and
SigLIP need different calibrations (SigLIP needs a HIGHER softmax temperature than CLIP)

❌ Letting an AI failure raise out of the sort pipeline ✅ Best-effort everywhere: log a
warning, yield no tags/category
