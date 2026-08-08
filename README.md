<div align="center">

<img src=".github/icon.svg" alt="" width="72" height="72" align="left">

# 📸 MediaSorter

**Review first. Organize photos and videos with confidence.**

[![CI](https://github.com/fileworks/media-sorter/actions/workflows/ci.yml/badge.svg)](https://github.com/fileworks/media-sorter/actions/workflows/ci.yml)
[![Latest release](https://img.shields.io/github/v/release/fileworks/media-sorter?display_name=tag&sort=semver)](https://github.com/fileworks/media-sorter/releases/latest)
[![License: MIT](https://img.shields.io/badge/License-MIT-orange.svg)](LICENSE)
![Platforms](https://img.shields.io/badge/platforms-macOS%20%7C%20Windows-blue)

![MediaSorter desktop application](docs/assets/screenshot.png)

</div>

MediaSorter turns mixed camera, phone, messenger, and backup folders into a
reviewed date-organized library. It extracts capture dates, keeps companion
files together, detects duplicate and similar media, and can categorize or tag
content with optional local AI. Processing stays on your machine unless you
explicitly select a cloud tagging provider.

## Install

Download the latest macOS DMG, Windows MSI/installer, or portable Windows ZIP
from [Releases](https://github.com/fileworks/media-sorter/releases/latest).
Python, Node, and ffmpeg are bundled.

The installers are currently unsigned. On first launch, use **right-click →
Open** on macOS or **More info → Run anyway** in Windows SmartScreen.

## Workflow

The application makes every mutation wait behind one reviewed plan:

1. **Sources** — assign input, reference, and destination folders. A whole root
   can be skipped for one run without changing the saved profile.
2. **Recipe** — choose a safe starting policy.
3. **Configure** — adjust movement, structure, cleanup, metadata, and AI
   settings. Changed values and their effects are visible.
4. **Review** — browse planned destinations and resolve every duplicate or
   similar-media set. Preview and scanning remain read-only.
5. **Execute** — confirm the frozen impact summary, follow progress, and inspect
   the final report.

Returning to folders or settings invalidates the dependent plan instead of
silently executing stale decisions. Interrupted operations are reconciled at
startup before new work is allowed.

## Safety model

- Source scanning, analysis, preview, and review are read-only.
- Every copy or move is staged and verified before publication; source removal
  happens only after a verified move.
- Existing destination content is indexed before execution. Exact matches are
  reported without another write.
- Duplicate losers are never silently deleted. They follow the selected keeper
  into that folder's `_copies/` leaf, with provenance retained in the report.
- XMP/AAE edits, Live Photo motion, RAW siblings, thumbnails, and audio notes
  travel as bounded media units by default. Unsafe splits block execution.
- Reference roots are immutable and enforced by the executor.
- Collision names are deterministic, and the same planner drives preview and
  execution.

Keep independent backups: verification protects each operation, not storage
failures that happen later. The complete contract is in
[preservation guarantees](docs/preservation-guarantees.md).

## Highlights

| Capability | What it does |
|---|---|
| Date extraction | EXIF → video metadata → filename → filesystem time |
| Organization | Deterministic year/month/day, source, camera, category, and rule routes |
| Duplicate review | SHA-256 exact matches, perceptual image/video groups, keyboard Resolve queue, and side-by-side comparison |
| Companion media | One placement, rename, collision, and duplicate outcome per media unit |
| Rules | Typed tagging and safe relative routing with previewed effects |
| Local AI | Optional checksum-pinned CLIP/SigLIP model packs for offline tagging and categorization |
| Reporting | Live progress, SQLite history, detailed provenance, and CSV/JSON export |
| Recovery | Startup reconciliation, support bundles, and explicit operator decisions for uncertain outcomes |
| Languages | Complete English and German interfaces |

The [settings reference](docs/settings-reference.md) documents every option,
default, compatibility gate, model tier, environment override, and routing
rule. The in-app descriptions and previews are the primary configuration UI.

## State and logs

MediaSorter uses stable platform directories:

| Platform | Config and history | Logs |
|---|---|---|
| macOS | `~/Library/Application Support/MediaSorter/` | `~/Library/Logs/MediaSorter/` |
| Windows | `%LOCALAPPDATA%\MediaSorter\` | `%LOCALAPPDATA%\MediaSorter\Logs\` |
| Linux/headless | `${XDG_CONFIG_HOME:-~/.config}/MediaSorter/` and `${XDG_DATA_HOME:-~/.local/share}/MediaSorter/` | `${XDG_STATE_HOME:-~/.local/state}/MediaSorter/log/` |

`mediasort.log` covers the launcher and `backend.log` the backend. Historical
lowercase state is copied non-destructively on first startup. See
[state paths, migration, and recovery](docs/state-and-recovery.md).

## Headless and CLI use

Run the backend on a NAS or server with Docker:

```sh
MEDIA_SOURCE=~/Pictures MEDIA_DEST=~/Sorted docker compose up -d
docker compose logs -f backend
```

The API listens at `http://localhost:8000` in this setup. A launch creates a
fresh capability token; direct CLI/API clients must send it. The packaged app
passes its token internally and never persists it.

```sh
backend/.venv/bin/python -m cli.main --help
backend/.venv/bin/python -m cli.main config set --source ~/Pictures --target ~/Sorted --move
backend/.venv/bin/python -m cli.main config validate
backend/.venv/bin/python -m cli.main scan
backend/.venv/bin/python -m cli.main preview
backend/.venv/bin/python -m cli.main sort start --watch
backend/.venv/bin/python -m cli.main sort report <task-id>
```

Use `--api-url` / `MEDIASORT_API_URL` for another backend and
`--api-capability` / `MEDIASORT_API_CAPABILITY` for its token. The live OpenAPI
reference is at `/api/docs`.

## Development

```sh
git clone https://github.com/fileworks/media-sorter.git
cd media-sorter
make install
make dev
make ci
cd frontend && npm run lint && npm test && npm run build
```

The desktop shell is Tauri/Rust, the API is FastAPI/Python, and the interface is
React/TypeScript. Releases bundle the frozen backend plus static ffmpeg and
ffprobe binaries.

- [Development guide](docs/development.md)
- [Architecture](docs/design.md)
- [Documentation index](docs/README.md)
- [Contributing](CONTRIBUTING.md)
- [Release signing](docs/release-signing.md)

Commits use Conventional Commits because semantic release derives versions and
changelogs from them. Keep credentials out of tracked files; clone-specific
instructions belong in ignored `CLAUDE.local.md`.

## Troubleshooting

- **A folder reports zero files:** confirm the drive is mounted and the selected
  root is readable. Unreachable roots now produce a blocking explanation.
- **The window stays blank:** inspect the platform log directory; a static
  splash should appear before React starts.
- **Windows local AI misses the GPU:** diagnostics must list
  `DmlExecutionProvider`.
- **A previous operation needs review:** resolve the startup recovery card.
  Nothing is deleted while its outcome is uncertain.

## Security

Report vulnerabilities privately through [SECURITY.md](SECURITY.md). The
backend binds to loopback by default. Outbound access is limited to explicit
features such as update checks, model installation, or a configured cloud AI
provider.

## License

[MIT](LICENSE) © Niklas Büchel
