# Read-only library audits

MediaSorter can audit an already organized destination independently of a sort.

**There is no longer a screen for this.** The Review rework replaced the
validation tab with the single item surface, so the audit is reached through the CLI or
the `/api/audit` routes, which are unchanged:

```console
mediasort audit /path/to/organized-library
mediasort audit /path/to/organized-library --subtree 2024/05 --sample 0.25
```

The audit never repairs, renames, relocates, or rewrites content in the library. It
reads file structures and hashes; its SQLite baselines and reports live in MediaSorter’s
application-data directory. This separation is deliberate: a finding may propose that a
safe ordinary plan exists, but only the normal reviewed planner and verified-transfer
path may perform that action.

Finding classes are:

- **Unreadable** — the file could not be read.
- **Structurally invalid** — its image decoder or video-container probe failed.
- **Content/extension mismatch** — decoded image content disagrees with its suffix.
- **Checksum divergence** — bytes differ from the checksum recorded during the
  first comparable audit. This is a factual difference, not a claim about why it
  changed.
- **Missing companion** — a previously recorded media-unit member is absent while
  another member remains.
- **Placement inconsistency** — capture date and the active date-folder settings
  imply a different location.

Files without a recorded checksum establish a baseline; that is reported as an outcome,
not damage. Every run stores its timestamp, scope, deterministic sampling method,
coverage, and findings. The newest 24 reports are retained. “New” means the finding was
absent from the previous audit with the same root and scope.

A sample is selected by hashing the seed and relative path, so repeated runs select the
same files. Sampled and interrupted runs are always labelled sample or partial; they
never claim full-library health.

Full hashing reads every selected byte. On spinning disks and network storage, quarterly
or after a suspected incident is usually kinder to hardware than a very frequent full
audit; use deterministic samples between full passes.
