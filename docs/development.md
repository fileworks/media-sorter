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

Use Python 3.12+ for the full locked development environment, Node 24 (declared
in `package.json` `engines` and `.nvmrc`/`.node-version`; Vitest does not run on
older Node), uv and
Rust stable. Core backend metadata permits Python 3.11+, but optional AI/native
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

Linux CI uses Ubuntu 24.04; macOS CI (`macos-latest`) and both macOS release
builds (`macos-26`, `macos-26-intel`) use macOS 26, still targeting macOS 12.
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

The frontend pins a temporary `minimatch` 11.0.1 override for
[GHSA-g3hv-75wg-m249](https://github.com/advisories/GHSA-g3hv-75wg-m249), because
the lint toolchain still requests vulnerable 10.x. Remove the override when
upstream dependency ranges include the patched version, then rerun lint,
typechecking, tests and the complete npm audit.

Routine Renovate branch updates stay inside the weekly window; urgent security
updates remain immediate. CI pins native runner images while retaining stable
check names and separates concurrent uv cache writers by job/matrix cell.
The Windows system-interpreter job uses uv copy mode across runner volumes;
the cached Rust auditor installs with an explicitly selected stable toolchain.
Release candidate checks use the same pinned auditor cache, retain a native
Cargo build cache and select copy mode for Windows packaging environments.
Python audits consume portable PEP 751 lock exports, checking all locked
platform/runtime variants without reinstalling the dependency graph.

Backend freezing uses the maintained ONNX native-provider hook and an explicit
platformdirs host hook, not whole-package collection of model-authoring tools or
foreign OS backends. The PR packaging job installs the same extras as releases;
a UI launch alone does not establish that the inference runtime was bundled.
Hugging Face's CLI/network modules are not needed by local-file tokenization.
A small SciPy hook collects only extension modules present in the locked wheel;
remove it when PyInstaller's upstream hook handles the removed `_cdflib` module.
Windows includes `tzdata` because it has no system IANA time-zone database.
Every backend freeze and packaged-artifact check runs `--verify-frozen-runtime`
before starting the application. This offline probe exercises real ONNX inference
on an authored Identity graph, local tokenization, image hashing, SciPy, platform
directories and time zones. It downloads no weights and touches no user state.
Normal application startup does not run the probe. Packaging warnings remain
visible; do not disable the freezer's logger to make a build appear clean.

The frontend explicitly denies `fsevents` install scripts through npm's
`allowScripts` policy. The locked package ships a universal macOS binary and no
source build inputs, despite registry metadata advertising `node-gyp rebuild`.
Both PR and release packaging load the native module after installation on macOS;
this proves the shipped binary works without running an unnecessary rebuild.
Other dependencies receive no blanket script approval. Review future script
requests and keep native packaging verification enabled.

Rust audit findings in Tauri's Linux dependency graph remain visible until
upstream releases a compatible fix. The [GTK binding upgrade](https://github.com/tauri-apps/tauri/issues/16264)
and [zbus 6 migration](https://github.com/tauri-apps/plugins-workspace/issues/3716)
track the remaining `glib`, `proc-macro-error` and standalone zvariant-family
warnings. These crates are absent from the locked Windows x64 and both macOS
normal/build/dev target graphs; they remain in the full lock audit for upstream
tracking. Recheck reachability when targets or dependencies change. Do not treat
a zero-vulnerability audit as zero warnings or add an
unreviewed suppression to make the output appear clean.

Artifact downloads retain GitHub's fail-on-digest-mismatch check and use
`skip-decompress` to avoid the deprecated Node ZIP extraction dependency
([upstream issue](https://github.com/actions/download-artifact/issues/484)).
The standard-library extractor keeps each platform's namespace, leaves portable
ZIP payloads intact and refuses traversal, symlinks, duplicate members and
overwrites. A tiny hosted round trip in `release-integrity` verifies this path
without rebuilding or publishing installers. Warning output is not suppressed.

The existing `com.mediasort.app` identifier is retained despite Tauri's naming
recommendation: changing an installed application's identity solely to silence
that notice risks upgrade/state continuity. Revisit only with an explicit
identity migration. Unsigned notarization notices are expected while signing
is disabled; partial signing credentials still fail preflight.

Releases are driven by **Conventional Commits**: you don't tag by hand, and merging
never releases by itself. Land `fix:`/`feat:`/`perf:` commits on `main`; shipping
is then one deliberate dispatch:

```bash
gh workflow run version-release.yml --ref main -f dry_run=true   # what would ship?
gh workflow run version-release.yml --ref main                   # ship it
```

The run summary of either shows the next version, its changelog section and the
commits it covers. A history of only docs, tests or `.github` changes has nothing
to release; material changes without a `feat`/`fix`/`perf` record stop with an
error rather than guessing a version (`scripts/releaseability.cjs`). Without
`dry_run`, Version Release then:

1. requires a successful unpublished **Release** candidate for that exact `main`
   commit, reusing one or starting one and waiting (about an hour; a failed
   candidate's failed jobs are retried once, a second failure ships nothing);
2. syncs the version everywhere (`scripts/sync-version.mjs` → `_version.py`,
   `tauri.conf.json`, `Cargo.toml`, …), updates `CHANGELOG.md`, commits
   `chore(release): vX.Y.Z` to `main` and pushes the `vX.Y.Z` tag atomically
   (if `main` moved meanwhile, the push is refused and nothing ships);
3. the tag triggers **Release**, which rebuilds the tagged commit natively —
   macOS arm64 + Intel `.dmg`, Windows `.msi`, NSIS `.exe` and portable `.zip` —
   repeats every gate and publishes the GitHub Release.

**Why two workflows.** Version Release decides *what* ships: a one-minute Linux job
that alone holds the token allowed to push to `main`. Release decides *whether it
works* and publishes: hour-long builds on three OS runners that execute
third-party tooling (npm, cargo, pip, ffmpeg downloads) and never see that token.
Keeping them apart also lets a tag be rebuilt without minting a new version, and
makes Release usable as an unpublished candidate (`gh workflow run release.yml
--ref main`); Version Release orchestrates both, so they remain one action.

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
Windows WebView smoke also isolates its browser profile. The window is created
before the backend starts on a worker thread. `get_api_session` waits for the
authenticated health probe without blocking the UI; pending startup owns its child
so window shutdown cancels retries and reaps the process. Windows backend creation
uses `CREATE_NO_WINDOW`. The packaged acknowledgement requires a mounted React root,
a ready session and a successfully loaded Blob image under the packaged CSP.
`img-src` and `media-src` allow `blob:` because media is fetched with the launch
capability and exposed through short-lived object URLs; script/network policies
remain restricted. Test previews in the packaged WebView, not just Vite.
On Windows, isolated smoke-profile cleanup first waits up to 60 seconds for every
`msedgewebview2.exe` that uses its profile to exit; a browser that outlives the app
fails the gate. Removal then retries for at most 30 seconds on sharing violations,
and on access-denied or directory-not-empty errors inside the WebView profile only.
Errors in configuration, data or logs fail immediately; persistent locks still fail.

The Windows release job also compiles a disposable NSIS fixture using Tauri's
cached compiler and runs `scripts/check_nsis_guard.py --makensis <makensis.exe>`.
It exercises the actual MultiUser initialization: NSIS strips `/D=` from
`$CMDLINE`, and MultiUser replaces `$INSTDIR`. The hook reads the original native
command line, rejects shared-root requests in an early hidden section, and
restores valid silent destinations before Tauri copies files. The fixture writes
no application payload or product registry keys. It also drives the real scope and
directory pages, reads the displayed directory control, and verifies clean,
remembered Programs-root and custom-folder defaults for both scopes. The hook uses
MultiUser's page-leave callback because changing scope restores the remembered
directory again. Model MultiUser's `%LOCALAPPDATA%\Programs` fallback when
UserProgramFiles is unavailable; a fresh CI profile may not have that known folder.
A manual `release.yml` dispatch on `main` repeats the full gates and builds
unpublished candidate artifacts; after a source fix, dispatch the new commit rather
than rerunning the old SHA. Release jobs have explicit time limits, a package's
artifact upload is retried once after a runner network failure, and a tag build is
never cancelled by a newer dispatch, so publication cannot stop halfway. If a tag
build still fails for a transient reason, rerun its failed jobs
(`gh run rerun RUN_ID --failed`); the tag and version stay unchanged.

The backend version is single-sourced from `backend/app/_version.py` (pyproject reads it
via hatchling's dynamic-version hook), so the running app always reports the released
version.

> **Required App:** the organization-owned `fileworks-release` GitHub App
> (repository permission Contents: read/write, installed on this repository and
> listed as a bypass actor of the `main` ruleset). Version Release reads the
> `RELEASE_APP_CLIENT_ID` organization variable and `RELEASE_APP_PRIVATE_KEY`
> organization secret, both shared with this repository, and mints a one-hour
> installation token. Only that token makes the pushed tag trigger the build;
> no personal token is involved and nothing expires on a calendar. Version
> Release checks the App first and fails without changes when it is missing or
> misconfigured. The push token is minted only after the candidate passes, and
> the release-tooling install runs with `--ignore-scripts`. Rotating the key:
> generate a new private key in the App settings, replace the secret, then
> delete the old key.

### Building locally

```bash
make release      # bundle-backend + bundle-ffmpeg + build-tauri
```

Output lands in `frontend/src-tauri/target/release/bundle/`. Builds are native-only —
you get an installer for the OS you're on. Never copy a Homebrew ffmpeg binary; the
bundled ones are statically linked and run on a clean machine. Let `make bundle-ffmpeg`
fetch the right ones.
Set `MEDIASORT_FFMPEG_CACHE` to a directory to reuse verified downloads; each
cached file is re-checked against the manifest SHA-256, and rate-limited hosts
are retried after their `Retry-After` delay.
