---
name: architecture
description: How the major pieces of MediaSorter connect and flow. Load when working on system design, integrations, or understanding how components interact.
triggers:
  - "architecture"
  - "system design"
  - "how does X connect to Y"
  - "integration"
  - "flow"
edges:
  - target: context/stack.md
    condition: when specific technology details are needed for a component
  - target: context/decisions.md
    condition: when understanding why the architecture is structured this way
  - target: context/ai.md
    condition: when working on AI tagging, smart categorization, or the CLIP encoder
  - target: patterns/add-endpoint.md
    condition: when adding a new API route
  - target: patterns/add-service.md
    condition: when adding a new service
last_updated: 2026-06-21
---

# Architecture

## System Overview

```
Tauri shell (Rust)  ──spawns──▶  FastAPI backend (Python)  ──▶  SQLite + filesystem
   React + TS UI    ◀──HTTP/WS──   ServiceContainer (DI)   ──▶  ffmpeg (bundled)
```

Tauri probes ports 8001–8009, 9001–9005, 7999 for a free one, spawns the PyInstaller-frozen Python backend on it, waits for `GET /api/health` to return 200, then loads the React UI. The UI calls `invoke("get_api_port")` to discover the port. No port is hardcoded anywhere.

Request path: React → HTTP → FastAPI router → `get_container(request)` → service → SQLite or filesystem → response. Long-running operations (sort, preview) are offloaded to `TaskManager` as background tasks and polled via `GET /api/sorting/{task_id}`. A WebSocket at `/api/logs/stream` streams live log lines during a sort.

The five-step wizard is the whole UX: **Configure → Analyse → Preview → Sort → Report**.

## Key Components

- **`ServiceContainer`** (`backend/app/core/bootstrap.py`) — central DI hub; all services are lazy singletons initialized on first property access and cached for the process lifetime. `AppFactory.create()` builds it; routes access it via `get_container(request)`.
- **`Config`** (`backend/app/core/config.py`) — plain `@dataclass` loaded from `config.json` in the platform config dir; `MEDIASORT_*` env vars overlay any field at startup. Saved back via `ConfigLoader.save()`.
- **`DatabaseManager`** (`backend/app/core/database.py`) — raw `sqlite3` wrapper; two tables: `operations` (one row per run) and `file_operations` (one row per file). Schema migrations are additive `ALTER TABLE … ADD COLUMN` calls in `init_schema()` guarded by `suppress(Exception)`.
- **`TaskManager`** (`backend/app/background_tasks/task_manager.py`) — single in-process background task slot with progress tracking, cancellation, and status polling. One concurrent task at a time.
- **`SortingService`** — orchestrator: date extraction → dedup → rule tagging → AI tagging → destination computation → file placement → DB write.
- **`DateExtractionService`** — date priority order: EXIF → video metadata → filename patterns → filesystem mtime.
- **`PreviewService`** — dry-run mirror of SortingService: reads and classifies every file, predicts destination, writes nothing. Categorization runs here; AI tagging does not.
- **`AITaggingService`** + **`CategoryClassifierService`** — both use the shared `VisionEncoder` (CLIP via fastembed); tagging writes keywords into files, categorization decides folder placement.
- **`RuleEngineService`** — tag files by extension, filename regex, size, or resolution before AI runs.
- **`ReportService`** — reads `file_operations` from DB; exports CSV or JSON.

## External Dependencies

- **SQLite** (stdlib) — primary persistence; `config.json` + `mediasort.db` live in `platformdirs.user_config_dir("mediasort")` or `MEDIASORT_CONFIG_DIR`. Never access directly from routes.
- **ffmpeg / ffprobe** — bundled with releases; not required for dev. Video date extraction and conversion go through `backend/app/utils/ffmpeg_utils.py`. On first run from source, install ffmpeg system-wide or let `make bundle-ffmpeg` fetch static binaries.
- **fastembed** (optional) — ONNX Runtime CLIP encoder for local AI; skipped if not installed. First use downloads ~300 MB model. Cloud AI providers (Azure AI Vision, Imagga, Google Cloud Vision) are alternatives configured via API key.

## What Does NOT Exist Here

- No background job queue (Celery, Redis, etc.) — `TaskManager` is an in-process singleton, one slot.
- No ORM — all SQLite access is raw `sqlite3` through `DatabaseManager` only.
- No authentication layer — local desktop tool, not multi-user.
- No cross-run duplicate detection — dedup compares files within one sort run, not against the existing destination library.
