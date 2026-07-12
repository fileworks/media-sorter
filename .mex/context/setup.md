---
name: setup
description: Dev environment setup and commands. Load when setting up the project for the first time or when environment issues arise.
triggers:
  - "setup"
  - "install"
  - "environment"
  - "getting started"
  - "how do I run"
  - "local development"
edges:
  - target: context/stack.md
    condition: when specific technology versions or library details are needed
  - target: context/architecture.md
    condition: when understanding how components connect during setup
  - target: patterns/debug-backend.md
    condition: when setup fails or the app won't start
last_updated: 2026-06-21
---

# Setup

## Prerequisites

- **Python 3.10+** — required; CI uses 3.12
- **Node 20+** — for frontend and semantic-release
- **Rust stable** — for the Tauri shell (`rustup` recommended)
- **ffmpeg** — NOT required for development; bundled in releases. For local video tests, install system ffmpeg or run `make bundle-ffmpeg` to fetch static binaries.
- **Linux only:** `libjpeg`, `libpng`, and GTK/WebKit headers for Tauri

## First-time Setup

1. `make install` — creates the Python venv, runs `npm install`, and checks the Rust toolchain (one-time)
2. No `.env` file needed — config is persisted to the platform config dir (resolved by `platformdirs`; override with `MEDIASORT_CONFIG_DIR`) and overridable via `MEDIASORT_*` env vars
3. `make backend` — starts the FastAPI backend on port 8000 with hot-reload; visit `http://localhost:8000/api/docs`
4. `make dev` — starts the full app (backend + Tauri dev window) in one terminal

For backend-only development (no Tauri), `make backend` is sufficient. The React UI can also be run standalone (inside `frontend/`, run: npm run dev) — it will call the backend on port 8000.

## Environment Variables

- `MEDIASORT_CONFIG_DIR` (optional) — redirects both `config.json` and `mediasort.db` to a custom directory (useful for Docker or parallel test environments)
- `MEDIASORT_DB_PATH` (optional) — overrides the SQLite DB path specifically without moving config
- `MEDIASORT_LOG_LEVEL` (optional, default `INFO`) — Python backend log level (`DEBUG`, `INFO`, `WARNING`, `ERROR`)
- `MEDIASORT_<FIELD>` (optional) — any `Config` dataclass field can be overridden; e.g., `MEDIASORT_SOURCE_DIRECTORY=/path/to/photos` or `MEDIASORT_AI_TAGGING_ENABLED=true`

## Common Commands

- `make install` — one-time setup (venv + npm + Rust check)
- `make backend` — FastAPI on `:8000` with hot-reload
- `make dev` — full app: backend + Tauri dev window
- `make test` — all backend tests + coverage summary
- `make test-cov` — tests + HTML coverage report (generated, not committed to repo)
- `make ci` — full backend CI gate: ruff + mypy + pytest (≥80% coverage)
- `make format` — `ruff --fix` + `ruff format` (auto-fixes)
- `make lint` — `ruff check` + `ruff format --check` (read-only)
- `make typecheck` — `mypy --strict` over the backend
- `make release` — full local release build (bundle-backend + bundle-ffmpeg + bundle-clip + build-tauri)
- Frontend (inside `frontend/`): npm run lint, npm run build

## Common Issues

**fastembed model download on first AI use:** The first sort with `ai_tagging_enabled` or `categorize_enabled` downloads the CLIP model (~300 MB) to the fastembed cache. Subsequent runs are fast. This is expected behaviour, not a hang.

**Local AI tests skipped in CI:** Tests that require fastembed use `pytest.importorskip("fastembed")` and skip cleanly when the package is not installed. This is intentional — CI runs without the AI deps.

**Port conflict:** If port 8000 is taken by another process, `make backend` will fail. Find the process with `lsof -i :8000` and kill it, or change the port with `MEDIASORT_PORT=8001 make backend`.

**`make dev` Tauri window blank:** The backend must finish starting before Tauri loads the UI. If the window stays blank, check the platform log directory for `backend.log` (macOS: ~/Library/Logs/MediaSorter/) for startup errors.

**Windows build requires MSVC:** Tauri on Windows needs the MSVC build tools, not MinGW. Install Visual Studio Build Tools with the C++ workload.
