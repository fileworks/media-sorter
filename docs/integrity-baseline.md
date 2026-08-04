# Media Mutation and Integrity Ledger

This ledger records the mutation surface of the engine. Rows are evidence, not a safety
claim: each one states what the code actually does today. The executable fixtures live
in `backend/tests/test_integrity_baseline.py`.

## Media mutation paths

| Component | Path | Current behavior | Evidence / remaining risk |
| --- | --- | --- | --- |
| `FileSystemService.safe_copy` | Copy and copy-mode quarantine | Stages under a private name, hashes while reading and rereads the closed stage, applies source timestamps, then publishes atomically | Verified; equal-size corruption and interruption never reach the destination path |
| `FileSystemService.safe_move` | Normal move and move-mode quarantine | Same-volume: publishes a second name for the identical inode, then drops the old one. Cross-volume: staged verified copy, then source removal | Verified; a failed source removal raises with `redundant_verified_copies` rather than losing either copy |
| `SortingService._process_file` | Normal organization | Authorizes a byte-identical manifest action, journals it, then executes the verified transfer | Verified; the manifest and journal are readable by reconciliation |
| `SortingService._quarantine*` | Unknown date, future date, junk, duplicate, already-in-destination, failed, corrupted | Routes through the same authorized executor with `kind: quarantine` | Verified; quarantine still has no durable restore relation |
| `SortingService._process_file` | Image/video conversion | Creates another output, then unlinks the placed original | Conversion is post-placement and is not committed through a shared verified replacement protocol |
| `SortingService._process_file` / `_apply_rename` | Planned/post-conversion rename | Calls `Path.rename` directly | Rename is outside a manifest/journal boundary |
| `MetadataService.set_creation_date` | EXIF date override | Rewrites embedded EXIF through `piexif` | Refused unless a reviewed profile authorizes `embedded_metadata`; media bytes change when it is |
| `MetadataService.write_keywords` | JPEG/TIFF and video tagging | Rewrites EXIF or remuxes to a temporary file and `os.replace`s the media | Embedded bytes change; replacement has no content/quality contract |
| `MetadataService.write_keywords` | PNG/HEIC/RAW tagging | Writes `<media-name>.xmp` | Sidecar is a separate filesystem mutation and is not journaled |
| `SortingService._process_file` | Filesystem timestamp synchronization | Preserves the source atime/mtime; writes the extracted date only when `preserve_filesystem_timestamps` is off | Verified; requested and observed values are recorded per action |
| `RepairService.repair_image` | In-place repair | Re-encodes to a temporary file and replaces the media | Refused unless a reviewed profile authorizes `repair`; content may still change when it is |
| `RepairService.repair_video` | In-place repair | Remuxes to a temporary file and replaces the media | Container bytes change; no manifest or recovery journal |
| `ConversionService` | Image/video conversion | Produces a collision-free derived file | Refused unless reviewed preservation *and* optimization profiles authorize it; validation and original retention are still delegated to the caller |

There is currently no user-facing restore executor. Operation-history database records
can describe past destinations, but they are not durable mutation journals and cannot
safely authorize or reconcile a restore.

## Guarantees now proven

The promises themselves — byte identity, staged publication, timestamp
best-effort, move-after-verify, the reduced-atomicity label, derived data never
entering the media — are stated once, for users, in
[preservation-guarantees.md](preservation-guarantees.md#the-default-organize-only).
They are not restated here. What this ledger adds is the durable record behind
them:

- Every placement is authorized by an immutable manifest action, written and
  fsynced **before** the filesystem is touched. A streaming sort appends one
  action per file to `manifests/<operation-id>.actions.jsonl`.
- `core/action_journal.py` records each stage transition with an fsync before the
  next irreversible step, so an interrupted run leaves an ordered prefix that
  reconciliation can classify.
- Mutation is gated by the policy guard, not a config boolean:
  `MUTATION_NOT_AUTHORIZED` is raised before anything is written.
- Each run stores an aggregate `IntegrityReport` at
  `reports/<operation-id>.integrity.json` — per-action hashes, byte counts, path
  transitions, preservation outcomes, commit method, warnings, recovery state.

## Transfer diagnostics

Every transfer failure carries a stable `reason`, the `phase` it happened in, and the
`source_safety` state, so a caller never has to parse an OS message.

| Reason | Meaning | Source safety |
| --- | --- | --- |
| `same_path` | The endpoints address one file (case alias, hard link, resolved alias) | `source_retained` |
| `destination_exists` / `destination_changed` | The final path was taken before or during commit; nothing was replaced | `source_retained` |
| `destination_parent_unusable` | The destination folder is a file or otherwise not a directory | `source_retained` |
| `insufficient_space` / `quota_exceeded` | The destination volume cannot hold the content | `source_retained` |
| `permission_denied` / `destination_read_only` | The filesystem refused the write | `source_retained` |
| `path_too_long` | The path exceeds the filesystem limit (`ENAMETOOLONG`, Windows 206/3) | `source_retained` |
| `resource_locked` | Another process holds the file open (`EBUSY`, Windows sharing/lock violation 32/33/1224) | `source_retained` |
| `volume_unavailable` | The volume disconnected mid-transfer (`EIO`, `ENODEV`, `ESTALE`) | `source_retained` |
| `unsafe_source_type` / `unsafe_path_link` | The source is not a regular file, or the path resolves through too many links | `source_retained` |
| `source_drift` / `source_changed_during_copy` | The content moved away from what was authorized or read | `source_retained` |
| `stage_hash_mismatch` / `stage_drift` | The staged copy failed independent verification | `source_retained` |
| `source_removal_failed` | The destination is verified but the source could not be dropped | `redundant_verified_copies` |
| `transfer_io_error` | An unmapped filesystem error; the raw errno is attached rather than guessed at | `source_retained` |

Stage files are named `.<stem≤12>.ms-stage-<16 hex>.tmp` in the destination directory:
hidden, collision-free, and short enough that staging does not push a long destination
path past the filesystem limit.

## Remaining gaps

- Post-placement conversion output and the post-conversion rename are applied
  outside a manifest action.
- Quarantine has no restore executor, so a quarantined original cannot be put
  back through the verified path.
- Reconciliation classifies and reports `stage_recoverable` and `resumable`
  actions but does not promote or retry them automatically.

## Regression fixture map

`backend/tests/test_integrity_baseline.py`:

1. equal-length corruption is rejected before publication;
2. interruption never publishes a partial final path;
3. copies retain source filesystem timestamps;
4. a same-volume move needs no second copy;
5. a cross-volume move whose source removal fails reports recoverable duplicate
   state;
6. an embedded EXIF date update changes the media hash (still unsafe baseline,
   now reachable only through a reviewed profile).

`backend/tests/test_verified_transfer.py` and `backend/tests/test_action_journal.py`
cover the protocol selection, degraded commit labelling, journal ordering, and
crash-truncation behavior directly. `backend/tests/test_organize_only_preservation.py`
proves byte identity across copy, move, rename, quarantine, and duplicate scenarios, and
pins the timestamp, sidecar, policy-refusal, manifest, journal, and report behavior.
`backend/tests/test_reconciliation.py` covers restart classification.

Existing focused suites additionally cover conversion replacement, image/video repair
replacement, quarantine behavior, copy-mode source retention, partial task persistence,
and sidecar/embedded tag writes.
