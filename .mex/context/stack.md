---
name: stack
description: Technology stack, library choices, and the reasoning behind them. Load when working with specific technologies or making decisions about libraries and tools.
triggers:
  - "library"
  - "package"
  - "dependency"
  - "which tool"
  - "technology"
edges:
  - target: context/decisions.md
    condition: when the reasoning behind a tech choice is needed
  - target: context/conventions.md
    condition: when understanding how to use a technology in this codebase
  - target: context/ai.md
    condition: when the technology question is about AI/CLIP/fastembed
  - target: context/setup.md
    condition: when version constraints affect how to install or configure the environment
last_updated: 2026-06-21
---

# Stack

## Core Technologies

- **Python 3.10+** — minimum; CI uses 3.12. Uses `X | Y` union syntax and `match` statements.
- **FastAPI** — web framework; async by default. App created via `AppFactory.create()` in `backend/app/core/bootstrap.py`.
- **SQLite** (stdlib `sqlite3`) — primary database; raw SQL, no ORM. Two tables: `operations` and `file_operations`.
- **Pydantic v2** — request/response validation in routes; `Config` itself is a plain `@dataclass`, not a Pydantic model.
- **Tauri (Rust)** — desktop shell and process launcher; handles port negotiation, window lifecycle, and exposes `invoke("get_api_port")` to the frontend.
- **React + TypeScript (Vite)** — frontend UI. Lives in `frontend/src/`. Component files PascalCase, hook files camelCase.

## Key Libraries

- **structlog** — structured JSON logging; always use `get_logger(__name__)` from `backend/app/core/logging_config.py`, never the stdlib `logging` module directly in application code.
- **platformdirs** — cross-platform config/log directory resolution; config lives at `user_config_dir("mediasort")`, logs at the platform log dir.
- **Ruff** — lint + format (replaces black/isort/pylint); run `make format` and `make lint`.
- **mypy --strict** — type checking; all new backend code must pass. Run `make typecheck`.
- **fastembed** (optional) — ONNX Runtime CLIP encoder for offline AI; NOT PyTorch/transformers. Skipped in CI if not installed (`pytest.importorskip`).
- **Pillow + pillow-heif** — image reading; HEIC/HEIF support enabled via `register_heif()` called at app startup in `AppFactory.create()`.
- **semantic-release** (root `package.json`) — automated versioning from Conventional Commits; do not tag releases by hand.

## What We Deliberately Do NOT Use

- **No SQLAlchemy or any ORM** — raw `sqlite3` through `DatabaseManager` only. Keeps the dependency footprint small for PyInstaller.
- **No Redis / Celery / any job queue** — `TaskManager` is an in-process singleton; sufficient for single-user desktop tool.
- **No PyTorch / transformers** — ONNX Runtime via fastembed for AI inference; avoids a 2 GB PyTorch install in the frozen bundle.
- **No OpenAI SDK / LangChain** — cloud AI providers use direct HTTP calls behind the `AITagger` interface; new providers must implement `base_tagger.AITagger`, not import third-party agent frameworks.
- **No `asyncpg` / `aiosqlite`** — SQLite access is synchronous `sqlite3` (already fast enough; no ORM session management needed).

## Version Constraints

- Python ≥ 3.10: `X | Y` union type syntax is used throughout; older Python will fail to import.
- fastembed 0.8.0: `jina-clip-v1` text encoder is broken (stuck at ViT-B-32). Use `ViT-B-32` model; do not attempt `jina-clip-v1`.
- Pydantic v2: `@field_validator` (not v1's `@validator`); `model_dump()` (not `dict()`).
