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
COLUMN` in `DatabaseManager.init_schema()`, after the `user_version` guard and verified backup;
each migration uses an explicit transaction with rollback on error, and after the versioned commits
the migrated database passes `PRAGMA integrity_check` before initialization completes (idempotent
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

❌ CLIP ViT-B/32 "Lite" via fastembed ✅ Retired 2026-10-11: a larger download than
SigLIP 2, weaker zero-shot and English-only. SigLIP 2 base runs directly on onnxruntime.

❌ `onnx-clip` or `jina-clip-v1` ✅ Pillow conflicts and a broken text encoder; neither is
needed with SigLIP 2

❌ Hardcoding scoring constants in tagger/categoriser code ✅ `tagger_slope` /
`tagger_offset` / `categorize_scale` / `categorize_floor` travel with the encoder
(`VisionEncoder`), calibrated with `scripts/evaluate_local_ai.py` on held-out fixtures

❌ Letting an AI failure raise out of the sort pipeline ✅ Best-effort everywhere: log a
warning, yield no tags/category
