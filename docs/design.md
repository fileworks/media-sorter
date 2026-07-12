# MediaSorter — Design Notes

Informal notes on how this is put together and *why*. For the exact API shapes,
open the live OpenAPI docs at `http://127.0.0.1:<port>/api/docs` while the app
is running. For the day-to-day workflow, see [development.md](development.md).

---

## The shape of the thing

```
Tauri shell (Rust)  ──spawns──▶  FastAPI backend (Python)  ──▶  SQLite + ffmpeg
   React + TS UI    ◀──HTTP/WS──   ServiceContainer (DI)
```

It's a desktop app, but internally it's a tiny client/server. The Rust shell
(Tauri) is mostly a launcher — it picks a free port, starts the PyInstaller-frozen
Python backend on it, and tells the React frontend where to find it via
`invoke("get_api_port")`. The UI then talks to the backend over plain HTTP plus a
WebSocket for the live log stream. No port is ever hardcoded.

The five-step wizard — Configure → Analyse → Preview → Sort → Report — is the
whole UX.

---

## Why HTTP instead of native Tauri IPC

The backend stays independently runnable and testable. You can `curl` it, point
pytest at it, or run it headless in Docker — none of which involve Rust or
JavaScript. The cost is a localhost round-trip, which is irrelevant for a
file-organising tool. Tauri command IPC would weld the business logic to the
Rust/JS boundary and make the Python untestable on its own.

---

## Port negotiation and process lifecycle

The shell asks the OS for a free loopback port (bind to port 0, read the assigned
port, release it), spawns the backend process with that port, waits for
`/api/health` to respond 200, then loads the UI. It retries up to five times to
handle the TOCTOU window where another process might grab the port between the
release and the backend's bind. On window close it sends SIGTERM so uvicorn can
flush its logs, then force-kills after a short grace period.

The frontend never assumes a port: it calls the `get_api_port` Tauri command and
builds its base URL from the answer. The one hardcoded port is the `127.0.0.1:8000`
fallback in `services/api.ts`, used only when `invoke` fails — i.e. when the UI is
opened in a plain browser against the Vite dev server rather than in the Tauri
window. That path is served by the separate `dev:backend` script, which is
deliberately pinned to 8000.

Both the Rust shell and the Python backend log to the same directory so startup
failures are always diagnosable:

| Platform | Log location |
|----------|-------------|
| macOS | `~/Library/Logs/MediaSorter/` |
| Windows | `%APPDATA%\MediaSorter\logs\` |
| Linux | `~/.local/share/mediasort/logs/` |

The Rust shell writes `mediasort.log`; the Python backend writes `backend.log`.
Both rotate at 2 MB (Rust: one backup; Python: three backups via `RotatingFileHandler`).

---

## Dependency injection

Everything goes through a single `ServiceContainer` (in `app/core/bootstrap.py`) —
lazy singletons for each service (sorting, preview, analysis, extraction,
filesystem, duplicate, rules, report, metadata, conversion, repair, config).
Routes never instantiate services directly; they pull them from the container.
Wiring lives in one place, and services are trivial to swap in tests.

---

## Services, briefly

The backend is around twelve services, each with one job:

- **`DateExtractionService`** — reads dates in priority order: EXIF → video metadata → filename → filesystem mtime
- **`FileSystemService`** — copy/move with post-op integrity checks
- **`DuplicateService`** — SHA-256 exact + perceptual hash (images *and* video)
- **`RuleEngineService`** — tag files by extension, filename, size, or resolution
- **`PreviewService`** — dry-run mirror of the sort that writes nothing
- **`SortingService`** — the orchestrator that ties everything together
- **`ReportService`** — reads/exports the per-run SQLite log
- **`MetadataService`**, **`ConversionService`**, **`RepairService`** — media helpers

Heavy file I/O is always offloaded with `asyncio.to_thread` so one slow file never
blocks the event loop or the progress poller.

---

## AI content tagging

Opt-in via `ai_tagging_enabled`. It adds content-based tags during a sort and
writes them into the files — EXIF `XPKeywords` for JPEG/TIFF, a `keywords` stream
tag for video, or a portable `.xmp` sidecar for everything else.

The providers all sit behind a single `AITagger` interface (`services/ai/base_tagger.py`)
with a `build_tagger(config)` factory. Taggers are deliberately **synchronous** —
`_process_file` already runs in a worker thread, so blocking ONNX/HTTP calls need no
event-loop gymnastics.

The default provider is **local CLIP via `fastembed`** — ONNX Runtime, no PyTorch,
no API key, no network after the first download. Each label gets an *independent*
probability using `sigmoid(slope · (cos(label) − cos(background)))` rather than a
competing softmax, so legitimately co-occurring tags don't cannibalise each other's
probability budget. Three free-tier cloud providers (Azure AI Vision, Imagga, Google
Cloud Vision) are available for an alternative taxonomy via API key.

Everything is best-effort: a missing model, bad key, or network error logs a warning
and yields no tags rather than failing the sort. Tagging runs on the **sort** path
only — preview stays AI-free to avoid burning quota or CPU on dry runs.

---

## Smart Categorization

A separate opt-in feature (`categorize_enabled`) that uses the same CLIP model for
a different job: deciding *where a file lands*. When on, every dated, non-duplicate
image/video is routed into one of the user-named topic folders nested under the date
hierarchy — `…/Y/M/D/<category>/`.

This is kept deliberately distinct from AI tagging: tagging writes descriptive
*metadata* and never moves anything; categorization is a *placement* decision and
writes no keywords. They share the embedder (so the model loads once) but are
configured, conditioned, and tested independently.

**Confidence gating** keeps bad classifications out. A file is only filed when it
clears an anchor-relative cosine floor *and* a dual gate: the top-1 probability ≥
`categorize_confidence_threshold` (default 0.55) *and* a minimum margin between
first and second place. Anything below goes to `_uncategorized/` — still correctly
dated and sorted, just not topic-binned. The softmax uses an un-saturated temperature
(≈40, *not* the shared CLIP logit scale of 100) so the gate is meaningful rather
than pinned near 1.0.

Unlike AI tagging, categorization **does run in preview** — because it decides
placement, the dry-run must show the predicted folder before the user commits.

Categorization is **mutually exclusive** with `preserve_subfolders` — both try to
impose a structure under the date folder, so only one can be on. The UI disables
whichever conflicts; the backend encodes the precedence deterministically so a
hand-edited config is never ambiguous. It does stack with the camera subfolder
(`…/Y/M/D/<category>/<camera>/`).

Every category name and camera-model name passes through `path_utils.sanitize_path_segment`
at both validation and build time — strips path separators, illegal characters, `..`
traversal attempts, and reserved Windows device names — so a typed folder name can
never escape the destination.

---

## Data and the "never delete" rule

State lives in the platform config dir (`platformdirs`): `config.json` plus a
SQLite DB (`mediasort.db`) with two tables — `operations` (one row per sort run)
and `file_operations` (one row per file). SQLite is plenty for the scale and needs
zero setup.

Files are **never deleted**. Anything unplaceable goes to a clearly named quarantine
folder under the destination so the user can always recover it:

| Folder | When |
|--------|------|
| `_unknown_dates/` | no date could be extracted |
| `_future_dates/` | extracted date is in the future |
| `_duplicates/` | content duplicate of a file seen earlier in this run |
| `_failed/` | the file operation itself raised an error |
| `_corrupted/` | failed post-copy integrity check and couldn't be repaired |

Duplicate detection is per-run only — it compares files within one sort, not
against what's already in the destination. Cross-run dedup isn't built yet.

---

## Self-contained builds

Releases bundle the frozen Python backend *and* static `ffmpeg` + `ffprobe`, so
end users install nothing — no Python, Node, or ffmpeg. The Rust shell prepends
the bundled `ffmpeg/` directory to the backend's PATH so bare `ffmpeg`/`ffprobe`
calls resolve to the bundled binaries. The fetch/extract logic lives in a single
stdlib-only `scripts/fetch_ffmpeg.py` used by both local builds and CI, so they
never drift. Builds are native-only: PyInstaller freezes native dependencies
per-OS, so each OS is built on its own runner.

---

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
