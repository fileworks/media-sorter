# MediaSorter — Development

How to set up, work on, test, and release MediaSorter. For *why* it's built the way it
is, see [design.md](design.md).

## Project layout

```
backend/    FastAPI app (app/) + tests/ — the brains
frontend/   React + TS UI, with src-tauri/ (the Rust shell) inside
scripts/    build helpers (fetch_ffmpeg, generate_branding, sync-version, …)
cli/        optional CLI that drives the backend API
docs/       these docs
Makefile    every dev/build command
```

## Setup

Use Python 3.12+ for the full locked development environment, Node 24, uv and
Rust stable. Core backend metadata permits Python 3.10+, but optional AI/native
packaging uses the fuller environment. Follow [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/)
for your OS (Windows needs MSVC build tools/WebView2; macOS Xcode tools; Linux
WebKit/system libraries). ffmpeg/ffprobe must be on PATH for media work in
development; installers bundle them. Linux may also need image-library headers.

From a fresh public clone, with these tools available:

```console
git clone https://github.com/fileworks/media-sorter.git
cd media-sorter
uv sync --project backend --locked --all-extras --dev
npm --prefix frontend ci
node scripts/dev-session.mjs
```

The last command starts backend and Tauri development together on Windows,
macOS or Linux. With GNU make and a POSIX shell, `make install` / `make dev`
are equivalent helpers. `make backend` starts the backend-only session.
The backend-only development launcher prints the per-launch capability for direct
API clients; the desktop launcher passes it internally. Never include it in a report.
The launcher invokes npm's JavaScript CLI on Windows and selects the platform's
backend interpreter, so Windows does not need a Unix shell or `.venv/bin/python`.

## Quality gates

Linux CI uses Ubuntu 24.04 and the Apple Silicon release build uses macOS 15.
Existing matrix/check names remain stable; all required gates still run. CI
artifacts expire after seven days; published release downloads remain available.

The backend uses **Ruff** (lint + format) and **mypy --strict** over `app` *and*
`tests` — the scope lives in `pyproject.toml`, so `mypy` is invoked without a path. The frontend uses **ESLint** (flat config) + **Prettier**.

```bash
make ci           # backend: ruff + mypy + pytest (≥80% coverage)
make format       # ruff --fix + ruff format
make lint         # ruff check + ruff format --check
make typecheck    # mypy

# frontend (run inside frontend/)
npm run lint          # eslint, zero warnings allowed
npm run format        # prettier --write
npm run format:check  # prettier --check
npm test              # Vitest
npm run build         # tsc + vite build
```

`make ci` covers the **backend only**. After any frontend change, run lint, format check, tests and
build in `frontend/` — CI checks those in a separate job.
The full backend/type gates run on Linux; Windows/macOS CI runs the native
filesystem suites named in `.github/workflows/ci.yml`. Full-suite fixtures include
POSIX permissions and symlinks. On Windows, symlink-dependent checks need
Developer Mode or elevation; use a short scratch path for native filesystem tests.

## Testing

```bash
make test         # all backend tests + coverage summary
make test-cov     # + HTML report at backend/htmlcov/index.html
```

Tests are unit (`test_services/`), integration (`test_api/`), and a few E2E. `make test-ci`/`make ci` enforce 80%; `make test` prints coverage without
enforcing that threshold. Image/video tests use
`pytest.importorskip` for their deps so the suite still runs in a minimal environment.

## Adding things

**A new service** — add it to `app/services/`, register it as a lazy singleton
in `ServiceContainer`, and inject it into routes via the container. Never instantiate a
service directly inside a route.

**A new route** — add it under `app/api/routes/`, pull services from the
container, and raise a `MediaSortException` subclass for errors (the bootstrap handler
turns those into the `{error, code, details}` JSON envelope automatically).

**A new user-facing string or generated concept** — add the same typed key to both
frontend locale catalogs. Backend validation returns stable message keys with typed
parameters rather than translated prose. Add bundled vocabulary to
`app/resources/concepts.json` with a canonical ID, complete English/German labels,
aliases, and prompts; do not translate user-entered values or technical folder names.

**A new rule condition or action** — extend the strict Python and TypeScript
discriminated unions together, then use the shared rule evaluator and destination
planner. Never accept a generic action dictionary and never sanitize a route into a
different path.

**A backend dependency with native code** — add `--collect-all=<pkg>` to the
`bundle-backend` Makefile target so PyInstaller picks up the compiled extension.

## Gotchas worth knowing

- Offload blocking file I/O with `asyncio.to_thread` — never block the event loop
  from an async route. This is the most common way to introduce latency bugs.
- Use `datetime.now(timezone.utc)`, not the deprecated `datetime.utcnow()`.
- Always `pathlib.Path`, never string path concatenation.
- `task_id` (UUID, for polling long-running operations) is **not** the same as
  `operation_id` (`"sort_<hash>"`, the stable DB key for a sort run).
- Run backend pytest from `backend/` so its `asyncio_mode = "auto"` configuration
  is loaded.
- Rule migrations write `config.pre-rules-v1*.json` before changing `config.json`.
  Keep that backup for rollback testing; future rule-set versions must fail closed
  without rewriting the file.

## Debugging

Both the Rust shell and the Python backend write to the current shared log root:

| Platform | Path |
|----------|------|
| macOS | `~/Library/Logs/MediaSorter/` |
| Windows | `%LOCALAPPDATA%\MediaSorter\Logs\` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/MediaSorter/log/` |

`mediasort.log` contains the Rust shell's startup/port-negotiation events. `backend.log`
contains structured JSON log lines from the Python backend (one `structlog` JSON entry
per line). It rotates at 5 MiB and retains three backups plus the active file (about 20
MiB maximum). A file-handler failure is non-fatal, so startup and console logging
continue.

Configuration, data, database, log, legacy migration, conflict, and recovery paths are
listed exactly in [state-and-recovery.md](state-and-recovery.md).

## Releasing

Releases are driven by **Conventional Commits** — you don't tag by hand, and you don't
release by accident either. Land `fix:` or `feat:` commits on `main` as usual, then
dispatch **Version Release** (`gh workflow run version-release.yml`) when that history is
meant to ship. Publishing is a decision, so it is a deliberate dispatch rather than a
side effect of merging. The workflow computes the next version from those commits,
updates `CHANGELOG.md`, syncs that version everywhere (`scripts/sync-version.mjs` →
`_version.py`, `tauri.conf.json`, `Cargo.toml`, …), and pushes a `v<version>` tag. That
tag triggers the release workflow, which builds every OS natively — macOS arm64 + Intel
`.dmg`, Windows `.msi`, NSIS `.exe`, and portable `.zip` — and uploads them to a
GitHub Release.

Tag builds publish a GitHub Release only after artifact type/content checks, packaged
backend/ffmpeg smoke tests, controlled native startup recovery, checksums, and the
declared signed/unsigned state all pass. The publication job uses the protected
`github-release` environment, so GitHub records the release deployment consistently with
the other Fileworks products. The
[clean-machine checklist](release-smoke-checklist.md) remains a post-release
confidence and regression procedure; it is not a routine publication gate. Signing is
optional but a partial credential set fails before packaging; see
[release-signing.md](release-signing.md).

Windows package checks validate the application subfolder and installed runtime
resources, fail on nonzero startup smoke codes, exercise MSI repair/NSIS reinstall,
and reject shared-root NSIS destinations. Backend packaging uses `--onedir
--noupx` so ambient UPX never rewrites collected native libraries. Clean-host
antivirus acceptance and both interactive install scopes still require the
checklist; do not describe a heuristic block as a proven false positive.
Packaged smoke checks isolate configuration, data, database and logs, including
any inherited database override; they must not migrate or modify operator state.

The backend version is single-sourced from `backend/app/_version.py` (pyproject reads it
via hatchling's dynamic-version hook), so the running app always reports the released
version.

> **One-time setup:** add a `SEMANTIC_RELEASE_TOKEN` secret (a fine-grained PAT
> with `contents: read/write`) so the pushed tag triggers the build — a tag pushed
> with the default `GITHUB_TOKEN` won't. If release-it creates a tag without that
> token, dispatch the existing tag explicitly:
> `gh workflow run release.yml --ref vX.Y.Z`.

### Building locally

```bash
make release      # bundle-backend + bundle-ffmpeg + build-tauri
```

Output lands in `frontend/src-tauri/target/release/bundle/`. Builds are native-only —
you get an installer for the OS you're on. Never copy a Homebrew ffmpeg binary; the
bundled ones are statically linked and run on a clean machine. Let `make bundle-ffmpeg`
fetch the right ones.
