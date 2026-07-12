---
name: agents
description: Always-loaded project anchor. Read this first. Contains project identity, non-negotiables, commands, and pointer to ROUTER.md for full context.
last_updated: 2026-06-21
---

# MediaSorter

## What This Is
A desktop app (Tauri + FastAPI) that sorts a folder of photos and videos into a date-organised year/month/day hierarchy, with preview, duplicate detection, AI content tagging, and smart topic categorization — all offline, self-contained.

## Non-Negotiables
- Never put business logic in route handlers — delegate to service layer
- Never block the async event loop — wrap all file/ffmpeg I/O in `asyncio.to_thread`
- Never raise raw HTTP exceptions — use `MediaSortException` subclasses from `backend/app/core/exceptions.py`
- Never query SQLite from routes — only through `DatabaseManager`
- AI features are always best-effort: on any error, log a warning and yield no tags/category rather than failing the sort

## Commands

**Backend**
- Dev: `make backend` (FastAPI on :8000, hot-reload)
- Test: `make test`
- CI gate: `make ci` (ruff + mypy + pytest ≥80% coverage)
- Format: `make format`
- Lint: `make lint`
- Type-check: `make typecheck`

**Full app**
- Dev: `make dev` (backend + Tauri window)
- Release build: `make release`

**Frontend** (inside `frontend/`)
- Lint: npm run lint
- Build: npm run build

## Scaffold Growth
After meaningful work, run GROW:
- Ground: what changed in reality?
- Record: update `ROUTER.md` and relevant `context/` files
- Orient: create or update a `patterns/` runbook if this can recur
- Write: bump `last_updated` on changed scaffold files and run `mex log` when rationale matters

The scaffold grows from real work, not just setup. See the GROW step in `ROUTER.md` for details.

## Navigation
At the start of every session, read `ROUTER.md` before doing anything else.
For full project context, patterns, and task guidance — everything is there.
