<!-- scope: FastAPI/raw-sqlite3/Pydantic backend rules and patterns AS USED IN THIS REPO -->

## Project Setup
- Python 3.10+ (dev venv at `backend/.venv`, created by `make install` — plain pip, not uv/poetry)
- Ruff is the single linter + formatter; Mypy `--strict`; gate: `make ci` (lint + typecheck + tests ≥80% cov)
- Layout: `backend/app/{main.py, api/{deps.py, schemas.py, routes/}, core/, services/, background_tasks/, utils/}`
- Optional extras: `[local-ai]` (fastembed/onnxruntime) — absent in CI; all AI imports are lazy so tests never need it

## FastAPI — Core Patterns
- **App factory**: `AppFactory.create()` in `core/bootstrap.py`; lifespan via `_make_lifespan` (captures the loop for thread-safe logging, tears down the TaskManager)
- **One router per resource** in `api/routes/`; included at app level with `prefix="/api"` + `tags`
- **Declare `response_model`** on endpoints with stable shapes. Deliberate exceptions returned as `dict`: the config blob, reports, and preview payloads (their shapes track the pipeline; a mirror model would silently drop fields — documented at each route)
- Custom exceptions inherit `MediaSortException` (`core/exceptions.py`); one global handler returns the `{"error", "code", "details"}` envelope. Never raise bare `HTTPException`
- Errors that must exist: 404 `TaskNotFoundError`/`OperationNotFoundError`, 409 `ConflictError`, 415 `UnsupportedMediaError`, 422 `ConfigValidationError`

## Dependency Injection
- **ServiceContainer** (`core/bootstrap.py`): every service is a lazy, cached singleton property
- Routes never touch `request.app.state` directly — use the `Annotated` aliases from `api/deps.py`:
  ```python
  ContainerDep = Annotated[ServiceContainer, Depends(get_container)]
  ConfigDep = Annotated[Config, Depends(get_config)]
  ```
- Config updates go through `POST /config` → `coerce_config_update()` (422 on unknown/incoercible keys) → `ConfigLoader.save` → `container.set_config()` (re-points live services; drops encoder-dependent services when `ai_model_tier`/`ai_allow_gpu` change)

## Database — raw sqlite3 via DatabaseManager
There is **no ORM**. `core/database.py` owns SQLite:
- `DatabaseManager._connect()` context manager: fresh connection per operation, `Row` factory, WAL mode, `busy_timeout=5000`, `foreign_keys=ON`, commit-on-success/rollback-on-error
- **Migrations are additive only**: new columns via `ALTER TABLE … ADD COLUMN` inside `init_schema()`, each wrapped in `suppress(Exception)` so re-runs are idempotent. Never drop or rename columns
- All DB work is synchronous → services expose a sync core (`_get_report_sync`) called via `asyncio.to_thread`
- Row → JSON coercions live in `core/serializers.py` (`suspicious` 0/1→bool, `tags` JSON-or-legacy-CSV→list); every reader must go through it
- Never query SQLite from a route — only through `DatabaseManager`

## Async & Blocking I/O
- `async def` routes everywhere; **all** blocking work (file ops, ffmpeg/ffprobe subprocess, PIL, sqlite, model inference) runs in a worker thread via `await asyncio.to_thread(...)`
- Long operations run as background tasks: `TaskManager.create_task()` → poll `TaskProgressResponse` (`api/schemas.py`)
- **Cancellation is cooperative**: `cancel_task` only sets `task.cancel_event`; the sort/preview loops check it between files, break, and persist partial results. Hard `asyncio.Task.cancel()` is reserved for `TaskManager.shutdown()` (process exit)
- Cross-thread logging is safe: structlog processor marshals onto the captured main loop (`core/logging_config.py`)

## Config
- `Config` is a **stdlib dataclass** (deliberate — not BaseSettings): `core/config.py`, persisted as `config.json` under `platformdirs` (override dir with `MEDIASORT_CONFIG_DIR`)
- `MEDIASORT_<FIELD>` env vars override any field; `_coerce_env_value` resolves the declared field type (unwraps both `typing.Union` and PEP 604 `types.UnionType` — see P2-1 in `REFACTOR_PROGRESS.md`)
- Never hardcode secrets; cloud AI keys live in config fields the user supplies

## Pydantic v2 — Schemas
- Per-route request/response models live in the route file; shared ones (used by >1 route) in `api/schemas.py`
- No `Any` in schema fields; separate Create/Read/Update shapes where an entity has them
- `@field_validator` for single-field, `@model_validator(mode="after")` for cross-field rules

## Services
- Business logic lives in `services/`; routes stay thin (validate → delegate → shape response)
- Per-file pipeline work (`SortingService._process_file`, `PreviewService._preview_file`) is synchronous by design — it already runs on a worker thread
- AI is always best-effort: any failure logs a warning and yields no tags/category — never a broken sort

## ⚠️ Never
- Never use bare `Request` injection — use `ContainerDep`/`ConfigDep`
- Never block the event loop — `asyncio.to_thread` for anything that touches disk/subprocess/model
- Never query SQLite outside `DatabaseManager`; never write destructive migrations
- Never raise bare `HTTPException` — use the `MediaSortException` tree
- Never return internal objects raw — Pydantic model, or a documented dict blob
- Never use `datetime.utcnow()` — `datetime.now(timezone.utc)`
- Never let an AI/model failure abort a sort — degrade to "no tags/category"
