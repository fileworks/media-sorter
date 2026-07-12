---
name: debug-backend
description: Diagnosing failures in the MediaSorter backend — sort pipeline errors, task hangs, AI failures, and config/DB issues.
triggers:
  - "debug"
  - "sort failed"
  - "task stuck"
  - "error"
  - "not working"
  - "investigate"
  - "diagnose"
  - "hang"
  - "logs"
edges:
  - target: context/architecture.md
    condition: when tracing which component in the pipeline produced the failure
  - target: context/ai.md
    condition: when the failure is in AI tagging or Smart Categorization
  - target: patterns/add-endpoint.md
    condition: when the failure is an HTTP 500 from a route
last_updated: 2026-06-21
---

# Debug Backend

## Context

The backend emits structured JSON log lines via `structlog`. Every failure boundary in the pipeline has a distinct log event. Start with logs before reading code.

Log locations (runtime, not in repo):
- **macOS:** ~/Library/Logs/MediaSorter/backend.log
- **Windows:** %APPDATA%\MediaSorter\logs\backend.log
- **Linux:** ~/.local/share/mediasort/logs/backend.log
- **Dev (terminal):** log lines print to stdout from `make backend`

Rotate at 2 MB, 3 backups. Both Rust shell (`mediasort.log`) and Python backend (`backend.log`) log to the same directory.

## Failure Boundary Map

| Symptom | Likely boundary | Where to look |
|---------|----------------|---------------|
| HTTP 4xx/5xx on any route | Exception handler in `bootstrap.py` | Check `MediaSortException` subclass raised; error envelope is `{error, code, details}` |
| Task stuck in `running` forever | `TaskManager` / blocking I/O on event loop | Check for missing `asyncio.to_thread` in the service |
| Sort completes but files in `_failed` quarantine | `FileSystemService.copy_or_move` | Log lines tagged `action=failed`; check permissions and disk space |
| Files in `_unknown_dates` quarantine | `DateExtractionService` | All four date sources failed; check EXIF with `exiftool`, video with `ffprobe` |
| Files in `_corrupted` quarantine | `RepairService` post-copy integrity check | Hash mismatch after copy; check source file health |
| AI tagging produces no tags | `AITaggingService` / encoder | Check if `ai_tagging_enabled=True` and encoder is not `None`; look for WARNING log lines |
| Categorization sends everything to `_uncategorized` | `CategoryClassifierService` confidence gate | Confidence threshold too high or temperature issue; see `context/ai.md` |
| Config not persisted across restarts | `ConfigLoader.save()` | Check write permissions to `user_config_dir("mediasort")` or `MEDIASORT_CONFIG_DIR` |
| DB error on startup | `DatabaseManager.init_schema()` | Check SQLite file permissions; look for `suppress(Exception)` hiding a real error |

## Steps

### 1. Read the log first
```bash
# Dev: logs print to terminal from `make backend`
# Packaged: tail the backend log
tail -f ~/Library/Logs/MediaSorter/backend.log | python3 -m json.tool
```
Each structlog line is one JSON object. The `event` key names the operation; `exc_info` contains tracebacks. Filter by `"level": "error"` or `"level": "warning"`.

### 2. Reproduce at the HTTP level
```bash
# Check a task's status directly
curl http://localhost:8000/api/sorting/<task_id>

# Trigger a dry-run sort to isolate sort vs. file-move issues
curl -X POST http://localhost:8000/api/sorting/start -H 'Content-Type: application/json' -d '{"dry_run": true}'

# Check current config
curl http://localhost:8000/api/config | python3 -m json.tool
```

### 3. Identify the component
- **Route layer** — `{error, code, details}` JSON in the HTTP response; `code` field names the exception class (e.g., `TASK_NOT_FOUND`, `CONFIG_ERROR`)
- **Service layer** — `ERROR` log lines with `exc_info`; look for the service class name in the `logger` field
- **AI layer** — `WARNING` log lines from `AITaggingService` or `CategoryClassifierService`; these are best-effort so they never raise to the route

### 4. Common fixes

**Task stuck in `running`:**
- Check for a service method that calls blocking I/O directly without `asyncio.to_thread` — the event loop is blocked and can't process the polling requests
- Look for an unhandled exception inside `TaskManager`'s worker coroutine that left the task in `running` state

**`TASK_NOT_FOUND` on a valid task_id:**
- `task_id` (UUID, per-run) ≠ `operation_id` (`sort_<hash>`, stable DB key). The polling endpoint takes `task_id`; report endpoints take `operation_id`.

**AI produces no tags silently:**
- `container.encoder` may be `None` (hardware below tier threshold or fastembed not installed)
- Check `HardwareProfile.probe()` tier by hitting `GET /api/health` — it may expose hardware info
- Run `python -c "from fastembed import TextEmbedding; print('ok')"` inside the venv to verify fastembed is installed

**Config not saving:**
- `POST /api/config` merges the body with the current config and calls `ConfigLoader.save()` — only changed fields need to be in the body
- Verify the config dir is writable: `ls -la $(python3 -c "from platformdirs import user_config_dir; print(user_config_dir('mediasort', 'mediasort'))")`

**Categorization always routes to `_uncategorized`:**
- Lower `categorize_confidence_threshold` (default 0.55) or `categorize_min_margin` (default 0.15)
- Verify `categorize_enabled=True` AND `preserve_subfolders=False` — they are mutually exclusive
- See `context/ai.md` for temperature and scoring details

## Debug
- Add `MEDIASORT_LOG_LEVEL=DEBUG` to get verbose per-file log lines during a sort
- The OpenAPI docs at `http://localhost:8000/api/docs` let you hit any endpoint interactively
- For DB inspection: `sqlite3 $(python3 -c "from platformdirs import user_config_dir; print(user_config_dir('mediasort', 'mediasort'))")/mediasort.db`

## Update Scaffold
- [ ] If this debug session revealed a recurring failure mode, add it to the table above
- [ ] If the fix changes a pattern (e.g., a new `asyncio.to_thread` wrapping rule), update `context/conventions.md`
- [ ] Update `.mex/ROUTER.md` "Known Issues" if the issue is not yet fixed
