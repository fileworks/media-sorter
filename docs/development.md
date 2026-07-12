# MediaSorter — Development

How to set up, work on, test, and release MediaSorter. For *why* it's built the
way it is, see [design.md](design.md).

---

## Project layout

```
backend/    FastAPI app (app/) + tests/ — the brains
frontend/   React + TS UI, with src-tauri/ (the Rust shell) inside
scripts/    build helpers (fetch_ffmpeg, generate_icons, sync-version, …)
cli/        optional CLI that drives the backend API
docs/       these docs
Makefile    every dev/build command
```

---

## Setup

```bash
make install      # venv + npm install + Rust toolchain check (one-time)
```

**Prerequisites:** Python 3.10+, Node 20+, Rust stable. On Linux you'll also
need the usual image libraries (`libjpeg`, `libpng`). ffmpeg is bundled in
releases — you don't need it installed to develop.

---

## Running

```bash
make dev          # backend (hot-reload) + Tauri window, one terminal

# or split across two terminals:
make backend      # FastAPI on :8000
make frontend     # Tauri dev window
```

---

## Quality gates

The backend uses **Ruff** (lint + format, replaces black/isort/pylint) and
**mypy --strict**. The frontend uses **ESLint** (flat config) + **Prettier**.

```bash
make ci           # backend: ruff + mypy + pytest (≥80% coverage)
make format       # ruff --fix + ruff format
make lint         # ruff check + ruff format --check
make typecheck    # mypy

# frontend (run inside frontend/)
npm run lint          # eslint, zero warnings allowed
npm run format        # prettier --write
npm run build         # tsc + vite build
```

`make ci` covers the **backend only**. After any frontend change, run
`npm run lint` and `npm run build` in `frontend/` — CI checks those in a
separate job.

---

## Testing

```bash
make test         # all backend tests + coverage summary
make test-cov     # + HTML report at backend/htmlcov/index.html
```

Tests are unit (`test_services/`), integration (`test_api/`), and a few E2E.
Coverage is currently ~86% against the 80% gate. Image/video tests use
`pytest.importorskip` for their deps so the suite still runs in a minimal
environment.

---

## Adding things

**A new service** — add it to `app/services/`, register it as a lazy singleton
in `ServiceContainer`, and inject it into routes via the container. Never
instantiate a service directly inside a route.

**A new route** — add it under `app/api/routes/`, pull services from the
container, and raise a `MediaSortException` subclass for errors (the bootstrap
handler turns those into the `{error, code, details}` JSON envelope automatically).

**A backend dependency with native code** — add `--collect-all=<pkg>` to the
`bundle-backend` Makefile target so PyInstaller picks up the compiled extension.

---

## Gotchas worth knowing

- Offload blocking file I/O with `asyncio.to_thread` — never block the event loop
  from an async route. This is the most common way to introduce latency bugs.
- Use `datetime.now(timezone.utc)`, not the deprecated `datetime.utcnow()`.
- Always `pathlib.Path`, never string path concatenation.
- `task_id` (UUID, for polling long-running operations) is **not** the same as
  `operation_id` (`"sort_<hash>"`, the stable DB key for a sort run).

---

## Debugging

Both the Rust shell and the Python backend write to a shared log directory:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Logs/MediaSorter/` |
| Windows | `%APPDATA%\MediaSorter\logs\` |
| Linux | `~/.local/share/mediasort/logs/` |

`mediasort.log` contains the Rust shell's startup/port-negotiation events.
`backend.log` contains structured JSON log lines from the Python backend (one
`structlog` JSON entry per line). Both rotate at 2 MB so they never grow
unbounded.

---

## Releasing

Releases are driven by **Conventional Commits** — you don't tag by hand. Push
`fix:` or `feat:` commits to `main` and the semantic-release workflow computes
the next version, updates `CHANGELOG.md`, syncs that version everywhere
(`scripts/sync-version.mjs` → `_version.py`, `tauri.conf.json`, `Cargo.toml`, …),
and pushes a `v<version>` tag. That tag triggers the release workflow, which
builds every OS natively — macOS arm64 + Intel `.dmg`, Windows `.msi` + `.exe` —
and uploads them to a GitHub Release.

The backend version is single-sourced from `backend/app/_version.py` (pyproject
reads it via hatchling's dynamic-version hook), so the running app always reports
the released version.

> **One-time setup:** add a `SEMANTIC_RELEASE_TOKEN` secret (a fine-grained PAT
> with `contents: read/write`) so the pushed tag triggers the build — a tag pushed
> with the default `GITHUB_TOKEN` won't. To cut a release by hand instead:
> `git tag v1.2.3 && git push origin v1.2.3`.

### Building locally

```bash
make release      # bundle-backend + bundle-ffmpeg + bundle-clip + build-tauri
```

Output lands in `frontend/src-tauri/target/release/bundle/`. Builds are
native-only — you get an installer for the OS you're on. Never copy a Homebrew
ffmpeg binary; the bundled ones are statically linked and run on a clean machine.
Let `make bundle-ffmpeg` fetch the right ones.
