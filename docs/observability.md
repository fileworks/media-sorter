# Events, diagnostics, and privacy

MediaSorter emits one stream of typed events per operation. The backend, the UI, and the
CLI all read the same vocabulary, so a surface can render an event it has never seen and
a support bundle can be redacted without knowing what produced it.

## The event contract

`backend/app/core/events.py` is the single registry. Each code declares its severity,
privacy class, and message key once:

| Group | Codes |
|---|---|
| Lifecycle | `operation.started` · `operation.preflight` · `operation.authorized` · `operation.authorization_refused` · `operation.phase_changed` · `operation.checkpoint` |
| Cancellation | `operation.cancellation_requested` · `operation.cancellation_observed` |
| Per item | `action.authorized` · `action.outcome` · `action.issue` · `transfer.retry` · `transfer.degraded` · `integrity.violation` |
| Recovery | `recovery.scanned` · `recovery.reconciled` · `recovery.review_required` |
| Diagnostics health | `logging.degraded` |
| Terminal | `operation.completed` · `operation.completed_with_warnings` · `operation.partial` · `operation.cancelled` · `operation.failed` |

Adding a code is additive. Renaming or removing one is a schema change and requires a
bump of `EVENT_SCHEMA_VERSION`.

### Two runtime guarantees

`EventRecorder` enforces the contract rather than documenting it:

- an unknown code raises `EventContractError` instead of being emitted;
- exactly one terminal event may be emitted per operation — a second one, or any
  event after it, raises.

Every event carries `operation_id`, `task_id`, `plan_id`, `profile_id`, `action_id`,
`phase`, and a contiguous `sequence`, so a timeline can be reassembled from any single
sink.

A sink that fails never breaks an operation. Observability degrades; media handling does
not.

## Privacy

Event context is sanitized before it reaches any sink:

| Kind of value | What happens |
|---|---|
| Credential-like keys (`api_key`, `token`, `password`, `secret`, `authorization`, `cookie`, `credential`, `passphrase`) | Replaced with `[REDACTED]`, at any nesting depth |
| Paths, filenames, roots, directories | Tokenized to `<rootN>/…depth/<12 hex>` |
| Bytes | Reduced to `<N bytes>` — media content can never be carried |
| Arbitrary objects | Reduced to `<TypeName>` without stringifying them |
| Everything else | Kept as-is |

Tokenization preserves relationships: two paths under one root share a root token, so a
reader can still see that a source and a destination were on the same volume without
learning either name. Tokens are stable within one operation and meaningless outside it.

`backend/tests/test_events.py` and `backend/tests/test_operation_observability.py`
assert these properties against real placements and real recovery, including that no
filename or configured API key survives into a rendered event.

## Runtime diagnostics

`GET /api/diagnostics` reports where diagnostics go and what has degraded — it
deliberately reports *state*, never content:

```json
{
  "version": "1.2.2",
  "logging": {
    "log_directory": "…/Logs/MediaSorter",
    "level": "INFO",
    "handlers": [{"type": "RotatingFileHandler", "path": "…/backend.log", "max_bytes": 5242880, "backup_count": 3}],
    "file_logging_active": true,
    "rotation": {"max_bytes": 5242880, "backup_count": 3, "retention_max_bytes": 20971520},
    "dropped_live_events": 0,
    "sink_failures": [],
    "degraded": false
  },
  "operations_needing_review": []
}
```

- **`dropped_live_events`** counts entries the live WebSocket queue discarded
  under backpressure. The queue is a ring buffer, so a slow client loses old
  entries rather than blocking an operation — but the loss is counted.
- **`sink_failures`** records persistent failures through a non-recursive
  channel, so a broken log sink cannot hide itself by failing to log.
- **`degraded`** is true whenever file logging is inactive or a sink has failed.

Logging setup never crashes the app. It also never pretends to have worked: a file
handler that could not be created leaves `file_logging_active: false` and a
`file_handler:<Error>` entry in `sink_failures`.

`operations_needing_review` lists operations that startup reconciliation could not
resolve on its own — see
[`state-and-recovery.md`](state-and-recovery.md#interrupted-media-operations).

## Honest progress

`TaskProgress` reports what is actually known rather than a single number:

| Field | Why it exists |
|---|---|
| `total_known` | False means the total is not countable yet. Render an indeterminate bar — "0%" would read as "no progress" when the truth is "we do not know yet" |
| `unit`, `bytes_done`, `bytes_total`, `bytes_total_known` | Item counts and byte counts move at different rates on mixed libraries |
| `eta_confidence` | `unknown` / `low` / `medium` / `high`. Never above `unknown` while the total is unknown, and never `high` on fewer than 50 observed items |
| `last_activity_at` | Liveness. A client distinguishes "slow but working" from "stuck" without the backend guessing a timeout |
| `last_checkpoint_at`, `last_checkpoint_label` | The last point an interruption could resume from without loss |
| `outcomes` | Per-code tally, so a "completed" run never hides its failed or skipped files |
| `cancellation_requested` vs `cancellation_observed_at` | Asking to stop and the worker noticing are different events, and the gap between them is what a user actually feels |
| `recovery_phase` | Set while the operation is reconciling rather than doing new work |

## Diagnostics bundle

`GET /api/diagnostics/bundle/preview` describes exactly what an export would contain and
creates nothing. `POST /api/diagnostics/bundle` writes a local ZIP. Nothing is ever
uploaded.

Included: version/platform manifest, configuration *shape*, operation timelines,
integrity reports, logging health, and optimization-contract status.

Never included: media contents, thumbnails, credentials, full paths (unless explicitly
requested), or arbitrary environment variables. A configured API key appears as
`{"type": "str", "configured": true}` — set, without its value.

Paths are tokenized by default. Including real paths requires `include_paths` **and** a
separate `acknowledge_paths`, because the preview already promised tokenization and
overriding it must be deliberate.

Before the archive is returned it is scanned for credential-shaped strings. A hit
deletes the archive and raises `SupportBundleLeakError` — a leak is a failure to produce
a bundle, never a surprise inside one.
