# MediaSorter — Design Notes

Informal notes on how this is put together and *why*. For the exact API shapes, open the
live OpenAPI docs at `http://127.0.0.1:<port>/api/docs` while the app is running. For
the day-to-day workflow, see [development.md](development.md).

## The shape of the thing

```
Tauri shell (Rust)  ──spawns──▶  FastAPI backend (Python)  ──▶  SQLite + ffmpeg
   React + TS UI    ◀──HTTP/WS──   ServiceContainer (DI)
```

It's a desktop app, but internally it's a tiny client/server. The Rust shell (Tauri) is
mostly a launcher — it picks a free port, starts the PyInstaller-frozen Python backend
on it, and tells the React frontend where to find it via `invoke("get_api_port")`. The
UI then talks to the backend over plain HTTP plus a WebSocket for the live log stream.
No port is ever hardcoded.

The interface has one navigation model: **Sources → Configure → Review → Execute**
(`Stage` in `frontend/src/lib/stageModel.ts` is the list). Sources owns typed roots,
recipes, and the non-mutating scan. Configure owns the settings groups and the
folder-tree preview. Review is **one surface**, not a set of tabs: a destination tree,
filter chips, and a single item list, all derived from the same rows so two numbers on
it cannot disagree. Execute owns the frozen impact summary, deliberate confirmation,
live operation state, and report. The operation center remains reachable across all four
stages.

Stage readiness and back-navigation invalidation are derived from the typed model in
`frontend/src/lib/stageModel.ts`; panels do not invent their own entry rules. Empty,
loading, error, and blocked screens use one `StateView` contract, and large lists/grids
share `useVirtualWindow`.

## Why HTTP instead of native Tauri IPC

The backend stays independently runnable and testable. You can `curl` it, point pytest
at it, or run it headless in Docker — none of which involve Rust or JavaScript. The cost
is a localhost round-trip, which is irrelevant for a file-organising tool. Tauri command
IPC would weld the business logic to the Rust/JS boundary and make the Python untestable
on its own.

## Port negotiation and process lifecycle

The shell asks the OS for a free loopback port (bind to port 0, read the assigned port,
release it), spawns the backend process with that port, waits for `/api/health` to
respond 200, then loads the UI. It retries up to five times to handle the TOCTOU window
where another process might grab the port between the release and the backend's bind. On
window close it sends SIGTERM so uvicorn can flush its logs, then force-kills after a
short grace period.

The frontend never assumes a port: it calls the `get_api_session` Tauri command and
receives both the selected port and a per-launch capability. HTTP sends the capability
in `X-MediaSorter-Capability`; WebSocket uses an authenticated subprotocol. The backend
rejects missing/wrong capabilities and any browser origin outside the exact
packaged/development allowlist before route dispatch. The one hardcoded port is the
`127.0.0.1:8000` fallback in `services/api.ts`, used only when `invoke` fails — i.e.
when the UI is opened in a plain browser against the Vite dev server rather than in the
Tauri window. That path is served by the separate `dev:backend` script, which is
deliberately pinned to 8000. `scripts/dev-session.mjs` generates one capability per
development launch and supplies it to the backend, Tauri shell, and Vite client so hot
reload does not weaken authentication.

Both the Rust shell and the Python backend log to the same directory so startup failures
are always diagnosable:

| Platform | Log location |
|----------|-------------|
| macOS | `~/Library/Logs/MediaSorter/` |
| Windows | `%LOCALAPPDATA%\MediaSorter\Logs\` |
| Linux | `${XDG_STATE_HOME:-~/.local/state}/MediaSorter/log/` |

The Rust shell writes `mediasort.log`; the Python backend writes `backend.log`. The Rust
log rotates at 2 MB with one backup. The backend JSON log rotates at 5 MiB with three
backups plus the active file (about 20 MiB maximum); inability to create the backend
file never blocks startup.

## Dependency injection

Everything goes through a single `ServiceContainer` (in `app/core/bootstrap.py`) — lazy
singletons for each service (sorting, preview, analysis, extraction, filesystem,
duplicate, rules, report, metadata, conversion, repair, config). Routes never
instantiate services directly; they pull them from the container. Wiring lives in one
place, and services are trivial to swap in tests.

## Services

`backend/app/services/` — lazy singletons in `core/bootstrap.py`, pulled from the
container by `api/deps.py`, never constructed by a route. The list is not reproduced
here: it was written when there were twelve and there are now fifty- nine, and a stale
inventory is worse than no inventory. `ls` is accurate.

Two rules hold across all of them:

- **Sync cores, async edges.** A service exposes a synchronous core; the route
  wraps it in `asyncio.to_thread`, so one slow file never blocks the event loop
  or the progress poller.
- **`SortingService` is the only orchestrator.** Everything that moves media
  goes through `OperationExecution`, which is the one place a placement becomes
  authorized, journalled and verified.

## Locale ownership

`Config.language` (`en | de`) is captured by each operation when it starts, so a run
never mixes languages mid-flight. Changing it affects the interface at once and the
*next* operation.

| Side | Owns |
|---|---|
| React i18n provider | interface strings, accessible names, errors, number/date formatting |
| Backend | stable message keys and parameters, application-generated vocabulary |
| Neither — never translated | technical identifiers, rename tokens, numeric date paths, user labels, quarantine folder names |

Bundled concepts carry canonical IDs plus per-locale labels and prompts; their
provenance separates untouched defaults from custom lists, so switching language
localizes the defaults and leaves custom text verbatim.

## Typed rules and shared destination planning

`RuleSet` v1 is a discriminated union. Tag and route rules share typed extension,
filename, size and resolution conditions, always evaluated against the
**source** file — before conversion or rename.

- Every enabled tag match runs. The first enabled route match wins, ordered by
  priority then stable saved order.
- A winning route is a relative suffix after the date/category/camera base:
  a filename rule matching `screenshot` in July 2026 gives `2026/07/screenshot/`.
  Absolute paths, traversal, empty segments, separators, control characters and
  reserved names are rejected. Quarantine and duplicate destinations bypass
  routes entirely.
- Preview and sort share one pure destination plan and one collision reservation
  (`_001`, `_002`, …). Preview is non-mutating and AI-free, which makes
  destination files created *after* preview the single intentional parity gap:
  sort takes the next safe name and reports where the file actually went.

Unversioned tag rules migrate locally with stable IDs and sequential priorities, after
copying the original to `config.pre-rules-v1*.json` — the rollback path. Malformed
entries are skipped with keyed warnings, route rules are never invented, and unsupported
future versions are left alone.

## AI content tagging

Opt-in (`ai_tagging_enabled`), sort-path only — preview stays AI-free rather than burn
quota and CPU on a dry run. Best-effort throughout: a missing model, bad key or network
error logs a warning and yields no tags instead of failing the sort.

Providers sit behind one `AITagger` interface with a `build_tagger(config)` factory
(`services/ai/base_tagger.py`). Taggers are deliberately **synchronous**:
`_process_file` is already on a worker thread, so blocking ONNX and HTTP calls need no
event-loop gymnastics.

Two decisions are worth knowing because the code alone does not explain them:

- **Independent probabilities, not softmax.** Each label scores
  `sigmoid(slope · (cos(label) − cos(background)))`. A competing softmax would
  make co-occurring tags cannibalise each other's probability budget.
- **Emitted labels are separate from model prompts.** CLIP may keep English
  prompts for bundled concepts where that measurably helps, while emitting German
  labels; SigLIP uses per-locale templates. Custom labels are always verbatim.
  Google results map through canonical aliases and unknown ones are dropped with
  a warning rather than emitted in the wrong language.

## Smart Categorization

The same CLIP model, a different job: `categorize_enabled` decides *where a file lands*
(`…/Y/M/D/<category>/`), where tagging decides what it is *called*. They share the
embedder so the model loads once, and are configured, conditioned and tested
independently.

| | AI tagging | Categorization |
|---|---|---|
| Writes | descriptive metadata | nothing — it picks a folder |
| Moves files | never | yes, it is a placement decision |
| Runs in preview | no | **yes** — a dry run must show the predicted folder |

**Confidence gating** keeps bad classifications out. A file is filed only when it
clears an anchor-relative cosine floor *and* both halves of a dual gate: top-1
probability ≥ `categorize_confidence_threshold` (0.55) and a minimum margin over second
place. Everything else goes to `_uncategorized/` — correctly dated and sorted, just not
topic-binned. The softmax temperature is ≈40, deliberately *not* the shared CLIP logit
scale of 100, so the gate means something instead of sitting pinned near 1.0.

Mutually exclusive with `preserve_subfolders` — both impose structure under the date
folder. The UI disables whichever conflicts and the backend encodes the precedence, so a
hand-edited config is never ambiguous. It does stack with the camera subfolder. Category
and camera names pass through `path_utils.sanitize_path_segment` at validation *and*
build time, so a typed folder name cannot escape the destination.

## Data and the "never delete" rule

State uses `PlatformDirs("MediaSorter", appauthor=False)` semantics: config is stored
under the config root, SQLite history under the non-roaming data root, and logs under
the log root. Some operating systems map config and data roles to the same physical
directory; code still resolves them independently.

Before any subsystem opens state, a locked migration coordinator copies historical
lowercase config/database and split-log sources without deleting them. It uses SQLite
snapshots for WAL consistency, preserves conflicts beside the current destination, and
records fingerprints in an atomic manifest. Config saves and schema upgrades are
atomic/recoverable; database upgrades use transactional `PRAGMA user_version` steps and
verified pre-upgrade backups. See
[state-and-recovery.md](state-and-recovery.md) for exact paths and names.

The SQLite DB has two tables: `operations` (one per run) and `file_operations` (one per
file).

Files are **never deleted**. Anything unplaceable goes to a named quarantine folder
under the destination — the list and what sends a file to each is in
[preservation-guarantees.md](preservation-guarantees.md#the-limits-stated-plainly);
`QUARANTINE_FOLDERS` in `services/destination.py` is the source both the sort and the
interface read. The names are stable across locales and routes never apply to them.

## Self-contained builds

Releases bundle the frozen Python backend *and* static `ffmpeg` + `ffprobe`, so end
users install nothing — no Python, Node, or ffmpeg. The Rust shell prepends the bundled
`ffmpeg/` directory to the backend's PATH so bare `ffmpeg`/`ffprobe` calls resolve to
the bundled binaries. The fetch/extract logic lives in a single stdlib-only
`scripts/fetch_ffmpeg.py` used by both local builds and CI, so they never drift. Builds
are native-only: PyInstaller freezes native dependencies per-OS, so each OS is built on
its own runner.

## Key decisions at a glance

| Decision | Why |
|----------|-----|
| HTTP IPC | backend is testable in complete isolation |
| SQLite | zero-config, portable, more than enough for the scale |
| Preview mode | verify before touching any file |
| Rules before ML | simple rules cover the majority of tagging cases |
| Tagging vs. categorization split | one writes metadata, the other decides placement; independent config, shared model |
| Categorization local-only | cloud taxonomies can't map to the user's custom folder names |
| Quarantine, never delete | users can always recover anything that couldn't be placed |
| Single background task | fine for typical run times; queueing deferred |
| PyInstaller + bundled ffmpeg | one self-contained installer, no runtime dependencies |
| Native-only release builds | native deps can't cross-compile; CI matrix per-OS |
