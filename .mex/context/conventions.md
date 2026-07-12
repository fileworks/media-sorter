---
name: conventions
description: How code is written in MediaSorter — naming, structure, patterns, and style. Load when writing new code or reviewing existing code.
triggers:
  - "convention"
  - "pattern"
  - "naming"
  - "style"
  - "how should I"
  - "what's the right way"
edges:
  - target: context/architecture.md
    condition: when a convention depends on understanding the system structure
  - target: patterns/add-endpoint.md
    condition: when writing a new API route
  - target: patterns/add-service.md
    condition: when writing a new service
  - target: patterns/debug-backend.md
    condition: when a convention violation is suspected as the cause of a bug
last_updated: 2026-06-21
---

# Conventions

## Naming

- Python files: `snake_case` (`sorting_service.py`, `extraction_service.py`)
- Python classes: `PascalCase`, suffix by role (`SortingService`, `ExtractionService`, `TaskManager`)
- Exception classes: suffix `Error` (e.g., `ConfigError`, `TaskNotFoundError`, `ConflictError`) — all must subclass `MediaSortException`
- React component files: `PascalCase` (`ConfigPanel.tsx`, `PreviewPanel.tsx`)
- React hook files: `camelCase` with `use` prefix (`useSorting.ts`, `useLogs.ts`)
- DB columns: `snake_case` (`execution_date`, `files_sorted`, `duplicate_of`)
- Config fields: `snake_case`, matching HTTP body keys 1:1 (no camelCase translation)
- Quarantine folders: `_` prefix, lowercase (`_unknown_dates`, `_duplicates`, `_failed`)

## Structure

- All backend services live in `backend/app/services/`; AI-specific services in `backend/app/services/ai/`
- Routes live in `backend/app/api/routes/`; one file per domain (`config.py`, `sorting.py`, `media.py`, etc.)
- Business logic never goes in route handlers — routes call service methods only; a route body should be 5–15 lines
- Inject the service container into routes via the typed `Depends` alias `ContainerDep` (and `ConfigDep` for config) from `backend/app/api/deps.py` — never a bare `Request` (Hard Rule 6)
- Each service is a class registered in `ServiceContainer`; no module-level singletons. Config changes go through `ServiceContainer.set_config()` — routes never poke `container._service._config`
- Shared response schemas live in `backend/app/api/schemas.py`; route-specific ones in the route file
- New DB columns: add via `ALTER TABLE … ADD COLUMN` in `DatabaseManager.init_schema()` with `suppress(Exception)` — never create separate migration scripts
- Frontend hooks live in `frontend/src/hooks/`; shared utilities in `frontend/src/lib/`

## Patterns

**Route pattern** — inject container via `ContainerDep`, call service, raise typed exception:
```python
from app.api.deps import ContainerDep

@router.post("/sorting/start")
async def start_sorting(body: StartSortRequest, container: ContainerDep) -> dict[str, str]:
    if container.task_manager.has_non_terminal_task("run"):
        raise ConflictError("A sort is already in progress.")
    task = container.task_manager.create_task(container.sorting_service.run, dry_run=body.dry_run)
    return {"task_id": task.id}
```

**Blocking I/O pattern** — all file and ffmpeg operations go through `asyncio.to_thread`:
```python
# Correct
result = await asyncio.to_thread(self._do_blocking_file_op, path)

# Wrong — blocks the event loop
result = self._do_blocking_file_op(path)
```

**Error handling** — raise from `backend/app/core/exceptions.py`, never construct `HTTPException` directly:
```python
# Correct
raise TaskNotFoundError(task_id)
raise ConfigError("source_directory is required")

# Wrong
raise HTTPException(status_code=404, detail="Not found")
```

**AI best-effort pattern** — catch all exceptions, log, return empty result:
```python
try:
    tags = self._tagger.tag(file_path)
except Exception:
    logger.warning("AI tagging failed", path=str(file_path), exc_info=True)
    tags = []
```

## Verify Checklist

Before presenting any code change:
- [ ] Business logic is not in the route handler — it delegates to a service
- [ ] Blocking I/O (file reads, ffmpeg calls) uses `asyncio.to_thread`
- [ ] New exceptions inherit from `MediaSortException` and define a short `code` string
- [ ] New services are added to `ServiceContainer` in `backend/app/core/bootstrap.py` as lazy properties
- [ ] New DB columns use `ALTER TABLE … ADD COLUMN` inside `init_schema()` with `suppress(Exception)`
- [ ] All paths use `pathlib.Path`, no string concatenation
- [ ] Datetimes use `datetime.now(timezone.utc)`, not deprecated `datetime.utcnow()`
- [ ] AI-dependent code is best-effort: catches exceptions and yields an empty result rather than failing
