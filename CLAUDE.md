# Best Practices Knowledge Base

**Stack:** A **Tauri (Rust)** shell launches a **FastAPI (Python 3.10+)** backend
(raw SQLite via `sqlite3` stdlib + Pydantic v2) on a free port and points a
**React + TypeScript (Vite)** frontend at it over HTTP + WebSocket. Local AI uses
CLIP (fastembed) / SigLIP 2 (onnxruntime), tier-gated by a hardware probe.

---

## Documentation Files

### Knowledge Base (when implementing)
- **`docs/kb-backend.md`** — FastAPI routes, DI container, raw-SQLite `DatabaseManager` patterns, Pydantic schemas, additive migrations
- **`docs/kb-api-contract.md`** — HTTP conventions, OpenAPI specs, pagination, CORS, status codes, error responses
- **`docs/kb-testing.md`** — pytest setup, database fixtures, unit vs. integration tests, mocking
- **`docs/kb-deprecated.md`** — Legacy patterns to avoid (async gotchas, anti-patterns)

### Project Context
- **`docs/design.md`** — System architecture, data model, feature overview
- **`docs/development.md`** — Setup, running tests, building frontend
- **`docs/settings-reference.md`** — Every config option, its default, and what it does (user-facing)

### Frontend conventions
- **State/data:** TanStack Query for all server state; hooks in `frontend/src/hooks/` own fetch + polling; the API client is `frontend/src/services/api.ts` (types live there, re-exported from `frontend/src/types/api.ts`).
- **Errors/loading:** surface via `frontend/src/lib/errorUtils.ts` + the toast context + per-step error/retry props; never show a raw stack trace. Two `ErrorBoundary`s (root in `main.tsx`, app-level in `App.tsx`). A static startup splash lives in `frontend/index.html` so there's no blank screen before React mounts.
- **Styling:** Tailwind + the semantic HSL tokens in `frontend/src/index.css` (`success`/`warning`/`error`/`info`, orange brand `primary`); prefer tokens over raw colors.
- **Quality gate:** `npm run lint` (ESLint, **`--max-warnings 0`**), `npm test` (Vitest, node env — pure logic only), `npm run build` (tsc + vite). `@typescript-eslint/no-use-before-define` is on to catch temporal-dead-zone bugs — declare helpers before the hooks/initialisers that use them.

---

## Hard Rules (Enforced Everywhere)

1. **Types first.** Declare `response_model` on FastAPI endpoints; use strict Mypy; no `Any` in Pydantic. → See `docs/kb-backend.md`
2. **Async by default.** Use `async def` routes and `await asyncio.to_thread()` for all blocking work; services expose sync cores. Integration tests use `TestClient` via the shared fixtures. → See `docs/kb-backend.md` and `docs/kb-deprecated.md`
3. **Schema-driven.** Never return internal objects raw; go through Pydantic (or one of the documented dict blobs: config/report/preview). → See `docs/kb-backend.md` and `docs/kb-api-contract.md`
4. **ServiceContainer pattern.** All services are lazy singletons in `backend/app/core/bootstrap.py`; routes pull them from the container via `backend/app/api/deps.py`. DB access goes through `DatabaseManager`; never query SQLite directly from routes. → See `docs/kb-backend.md`
5. **No blocking I/O on the event loop.** All file/ffmpeg operations go through `asyncio.to_thread`. → See `docs/kb-backend.md` and `docs/kb-deprecated.md`
6. **Dependency injection via Depends.** Use `Annotated` type aliases. Never bare `Request` injection. → See `docs/kb-backend.md`
7. **Error handling standardized.** Custom exceptions inherit from `MediaSortException`; the global handler returns the `{"error", "code", "details"}` envelope. → See `docs/kb-api-contract.md`
8. **Config via the `Config` dataclass + `ConfigLoader`.** Persisted as `config.json` (platformdirs); `MEDIASORT_<FIELD>` env vars override; never hardcode secrets. → See `docs/kb-backend.md`
9. **Schema migrations in `DatabaseManager`.** New columns are added via `ALTER TABLE … ADD COLUMN` inside `DatabaseManager.init_schema()`, guarded by `suppress(Exception)` so re-runs are idempotent. Never drop or rename columns. → See `backend/app/core/database.py`
10. **Test isolated.** Unit tests (services with mocked collaborators), integration tests (HTTP + real temp DB). Aim >80% coverage on business logic. → See `docs/kb-testing.md`

---

## Implementation Checklist

- **Adding an API endpoint?** Check `docs/kb-api-contract.md` (contracts) and `docs/kb-backend.md` (routes/DI)
- **Writing database code?** See `backend/app/core/database.py` (SQLite via `DatabaseManager`) and `backend/app/core/serializers.py` (row coercions: int→bool, comma-string→list).
- **Building a service?** Check `docs/kb-backend.md` (DI, schemas) and `docs/kb-deprecated.md` (async gotchas)
- **Writing tests?** Check `docs/kb-testing.md` (fixtures, mocking, isolation)
- **Uncertain about a pattern?** Start with `docs/kb-deprecated.md` to rule out anti-patterns, then read the other kb files above

---

## Local Overrides

This committed file is the project guidance for both workspace and standalone
clones. Put machine-specific paths, local commands, or private preferences in an
ignored `CLAUDE.local.md` at the repository root. Never store credentials or
other secrets there.
