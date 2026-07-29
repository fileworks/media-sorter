# State paths, migration, and recovery

MediaSorter resolves desktop state through
`PlatformDirs("MediaSorter", appauthor=False, roaming=False)`. Configuration,
non-roaming data, and logs are separate path *roles* even on platforms where the
operating system maps two roles to the same physical directory.

The non-roaming data directory also contains `thumbnail-cache/`. This directory
is derived, budget-bounded state—not user data. It may be deleted while the
application is stopped; visible thumbnails are regenerated lazily. No cleanup
timer runs in the background. Cache corruption or an unavailable cache volume
degrades to on-demand rendering and does not affect source media, the catalog,
operation history, manifests, or journals.

## Current desktop paths

| Platform | Configuration | History database | Launcher and backend logs |
|---|---|---|---|
| macOS | `~/Library/Application Support/MediaSorter/config.json` | `~/Library/Application Support/MediaSorter/mediasort.db` | `~/Library/Logs/MediaSorter/mediasort.log` and `backend.log` |
| Windows | `%LOCALAPPDATA%\MediaSorter\config.json` | `%LOCALAPPDATA%\MediaSorter\mediasort.db` | `%LOCALAPPDATA%\MediaSorter\Logs\mediasort.log` and `backend.log` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/MediaSorter/config.json` | `${XDG_DATA_HOME:-~/.local/share}/MediaSorter/mediasort.db` | `${XDG_STATE_HOME:-~/.local/state}/MediaSorter/log/mediasort.log` and `backend.log` |

The migration manifest is `state-migration-v1.json` in the current data
directory. It records source fingerprints and outcomes so repeated or
interrupted startups do not create duplicate copies.

## Historical sources

Before normal config loading, database initialization, or file logging, a
desktop startup checks these historical locations:

| Platform | Historical config and database | Historical split-log directory |
|---|---|---|
| macOS | `~/Library/Application Support/mediasort/` | `~/Library/Logs/MediaSorter/` |
| Windows | `%LOCALAPPDATA%\mediasort\mediasort\` | `%LOCALAPPDATA%\MediaSorter\logs\` |
| Linux | `${XDG_CONFIG_HOME:-~/.config}/mediasort/` | `${XDG_DATA_HOME:-~/.local/share}/mediasort/logs/` |

Migration never deletes a legacy source:

- An absent destination receives an atomically installed, verified copy.
- Identical content or a same-file alias is recorded without replacement.
- Conflicting legacy content is retained in a collision-proof
  `legacy-<kind>-<UTC timestamp>-<fingerprint>...` file beside the current
  destination; the current destination remains authoritative.
- SQLite is copied through its backup API, including committed WAL state.
- A cross-process lock and atomic manifest make concurrent and interrupted
  startup retry-safe.
- An unrecoverable copy, verification, lock, or manifest error stops startup
  with the affected path instead of silently creating fresh state.

Explicitly overridden roots are operator-owned and are not treated as legacy
migration destinations or sources.

## Configuration and database recovery

`config.json` carries the current `mediasort-config-v1` schema marker. Saves use
a same-directory temporary file, flush and `fsync`, then atomic replacement.
The previous valid primary is kept as `config.json.bak`.

If the primary is malformed, MediaSorter preserves it as
`corrupt-config-<UTC timestamp>-<hash>.json` and restores a valid backup. If the
backup is malformed too, it is also preserved (with a collision-proof name),
defaults are loaded, and both affected paths are logged. A config declaring a
future schema version is left unchanged and startup fails actionably.

SQLite history uses `PRAGMA user_version`. Before an existing schema is
upgraded, MediaSorter writes and verifies
`mediasort.db.pre-migration-v<from>-to-v<to>-<UTC timestamp>.bak`. Each version
step is transactional; unexpected schema or SQL failures roll back and stop
startup while the verified backup remains available.

## Interrupted media operations

Media mutations leave two durable records in the data directory:

| Path | Contents |
|---|---|
| `manifests/<manifest-id>.manifest.json` | The immutable authorization: source identity, expected hash and size, destination, effects, profile and rule versions |
| `journals/<manifest-id>.journal.jsonl` | The append-only, fsynced stage timeline; a terminal `state` record closes it |

The manifest is written before its journal opens, and no journal record returns
to the caller before it is flushed and `fsync`ed. A crash therefore leaves an
ordered prefix, never a rewritten record.

At startup, before serving requests, MediaSorter classifies every journal that
has no terminal record. Each authorized action is compared against what is
actually on disk by hash, never by size or by assumption:

| Classification | Situation | What startup does |
|---|---|---|
| `completed` | Destination hashes to the authorized content and no source removal is outstanding | Closes the record; discards stages now proven redundant |
| `redundant_verified_copies` | Destination is verified and the original still exists | Removes the source **only** if the journal recorded the commit; otherwise leaves both copies and asks for review |
| `stage_recoverable` | No destination, but a staged file hashes to the authorized content | Keeps the stage and offers promotion; never deletes it |
| `resumable` | Nothing was published and the source still matches the manifest | Offers a retry |
| `ambiguous` | Unexpected destination content, or no verified copy anywhere | Changes nothing and reports the operation for review |

Cleanup only ever removes a stage whose content is already published at a
verified destination. A crash-truncated final journal line is dropped before
recovery appends to it, so the timeline stays parseable. Operations that still
need a person are listed on `app.state.operations_needing_review`.

## Overrides

| Variable | Effect |
|---|---|
| `MEDIASORT_CONFIG_DIR` | Configuration root. For backward-compatible Docker/headless deployments, it also supplies the data/database root when neither of the newer data/database overrides is set. |
| `MEDIASORT_DATA_DIR` | Non-roaming data root and default parent of `mediasort.db`. |
| `MEDIASORT_DB_PATH` | Exact SQLite file path; takes precedence over the data-root default. |
| `MEDIASORT_LOG_DIR` | Shared Rust launcher and Python backend log root. The launcher passes the resolved value to its backend child. |

The Docker volume continues to set `MEDIASORT_CONFIG_DIR=/config`, so existing
containers keep `/config/config.json` and `/config/mediasort.db`.
