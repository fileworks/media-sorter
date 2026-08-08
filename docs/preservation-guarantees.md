# What MediaSorter guarantees about your files

This is the promise the default configuration makes, the exact limits of that promise,
and what to do when something goes wrong. It is written to be read before trusting the
tool with media you cannot replace.

## The default: Organize Only

Out of the box MediaSorter **only ever puts files in different places**. It copies,
moves, renames, and quarantines. It does not re-encode, repair, compress, or write
anything into your media.

Concretely, for every file:

- The destination holds **the same bytes**, verified by SHA-256 — not by file
  size, and not by trusting the operating system's copy.
- The file is written to a hidden staging name first and only appears at its
  final path once it is fully verified. **A partial file is never visible.**
- The original's **modification and access times are applied** to the
  destination.
- **Nothing inside the file changes.** No EXIF write, no tag embedding, no
  container rewrite.
- In Move mode, the original is deleted **only after** the destination is
  verified and that fact is written to durable storage.

Derived information — AI tags, rule tags, corrected dates — goes to the operation
report, and to a `<file>.xmp` sidecar if you ask for one. It never goes inside the
media.

### Companion files move as one media unit

By default, recognized edit sidecars, Live Photo motion files, RAW siblings, video
thumbnails, and audio notes are bound to one primary in the same directory. The primary
alone decides the date, route, rename, collision suffix, and duplicate outcome. It
commits first; each companion then uses the same destination stem and the same
verified-transfer contract.

If a companion cannot be verified, already committed members remain valid, the failing
source is retained in Move mode, and the report names an `incomplete_unit`. A crash
between members uses the existing manifest/journal reconciliation; it does not rely on a
new cleanup mechanism.

## The limits, stated plainly

**Timestamps are best-effort by filesystem.** Not every filesystem can store a
nanosecond-precision time, and none can portably restore creation time, ownership, ACLs,
or extended attributes. MediaSorter applies what the target supports and **reports what
it could not reproduce** as a warning on that file. It never claims full preservation it
did not achieve. Byte identity is independent of this and always holds.

**Atomic publication is not universal.** On filesystems that support it, the
final path appears atomically and cannot clobber an existing file. Where that is
unavailable (some network shares, some removable media), MediaSorter uses a documented
recoverable protocol and labels the result `recoverable_non_atomic` — a smaller
guarantee, shown rather than hidden.

**Quarantine is not a backup.** Files MediaSorter cannot place go to a named
folder under the destination. They are never deleted — but they live on the same disk as
everything else, so keep independent backups.

| Folder | Sent there when |
|---|---|
| `_undated/` | no usable date could be established, including implausible future dates |
| `_junk/` | thumbnail or cache debris |
| `_corrupted/` | the file could not be read, placed, or repaired |
| `<keeper folder>/_copies/` | content is another copy of the keeper in that folder |

Content already verified in the destination is reported but not written again. Duplicate
copies are staged and verified like every other placement, never deleted without a verified
result, and carry their own date, source root, would-be path, and keeper relation in the
run audit.

**Companion recognition is intentionally bounded.** A same-stem arbitrary file
such as `README.txt` is not moved with `README.jpg`, and a recognized sidecar in a
different directory is reported as unmatched. `leave_in_place` deliberately splits
units; `ignore` restores media-only behavior. Conversion preserves companion bytes but
cannot rewrite references stored inside them, so Preview shows that limitation before
execution.

## Turning mutation on

Conversion, repair, embedded metadata, and tag embedding each require a reviewed
**mutation profile** — see
[`settings-reference.md`](settings-reference.md#media-mutation-profiles).
Switching on the setting alone is refused with `MUTATION_NOT_AUTHORIZED` before anything
is written.

Optimization additionally requires a per-format **validation contract** that has passed
curated fixtures. No format has passed yet, so optimization cannot run at all today —
see [`optimization-contracts.md`](optimization-contracts.md) for what each contract will
have to prove, including that "visually lossless" is reported as *met configured
checks*, never as *identical*.

### Upgrading from a configuration that had these on

Your settings are kept exactly as they were, and the profile is marked for review. The
next run stops with `migration_review_required` until you confirm the carried-over
settings are still what you want. Nothing is silently enabled, and nothing is silently
switched off.

### Rolling back

`reset_to_organize_only()` returns a configuration to the strict default. It can only
remove authorization, never grant it, so it cannot weaken the byte-identical guarantee
regardless of what it is applied to. Quarantined originals, journals, and reports are
never touched by a rollback.

This configuration rollback is **not an undo for a run**. MediaSorter has no run-level
undo, rollback, or automatic restore operation. Its safety mechanism is legibility
before commit: Preview records the winning and rejected date sources, matched rules,
category confidence, duplicate evidence, media-unit membership, and destination-path
derivation while the plan is built. Execute then presents re-runnable effects separately
from effects that remove, relocate, or rewrite originals, and requires deliberate
confirmation. If the plan or configuration changes, that confirmation is invalidated and
the impact must be reviewed again.

## When something goes wrong

Every failure carries a stable reason, the phase it happened in, and — most importantly
— **the source-safety state**: whether your original is still there. The full table is
in
[`integrity-baseline.md`](integrity-baseline.md#transfer-diagnostics). The one to
know is `redundant_verified_copies`: the destination is verified *and* the original
still exists. Nothing was lost; there are simply two copies.

### After a crash or power loss

On the next start, MediaSorter reads what it had authorized (the manifest) and how far
it got (the journal), then hashes what is actually on disk. It finishes records it can
prove, and it refuses to clean up anything it cannot. In particular it will not delete
an original unless the destination hashes correctly
*and* the commit was recorded before the crash.

Anything ambiguous is left exactly as it is and reported for you to decide about, via
`GET /api/diagnostics` → `operations_needing_review`. Full behavior:
[`state-and-recovery.md`](state-and-recovery.md#interrupted-media-operations).

## Where the evidence lives

| What | Where |
|---|---|
| Authorization for each action | `manifests/` in the data directory |
| Stage-by-stage execution record | `journals/` in the data directory |
| Per-run integrity report (hashes, bytes, outcomes, warnings) | `reports/<operation-id>.integrity.json` |
| Application logs | See `GET /api/diagnostics` → `logging.log_directory` |

Reports and logs contain hashes, byte counts, and outcomes. Events published to the UI
have paths and filenames tokenized and credentials removed —
[`observability.md`](observability.md#privacy).

## Verifying the claims yourself

These are executable, not aspirational:

| Claim | Test |
|---|---|
| Byte identity across copy, move, rename, quarantine, duplicate | `backend/tests/test_organize_only_preservation.py` |
| Corruption and interruption never reach the destination | `backend/tests/test_integrity_baseline.py` |
| A verified copy survives interruption at every boundary | `backend/tests/test_fault_injection.py` |
| Restart classification and safe cleanup | `backend/tests/test_reconciliation.py` |
| Copy/move on either volume layout, full disk, locked files, mixed batches, migration, rollback | `backend/tests/test_transfer_end_to_end.py` |
| No credential, path, or media byte reaches an event | `backend/tests/test_events.py` |
| No optimizer runs before its contract is validated | `backend/tests/test_optimization_contracts.py` |
| Companion binding, unchanged eligible counts, unit placement, duplicate isolation, and incremental refresh | `backend/tests/test_companion_media_units.py` |
