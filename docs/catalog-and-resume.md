# The catalog, and what a second run may reuse

MediaSorter keeps a persistent index so that scanning a library twice does not cost
twice. This document is the contract that index answers to: where it lives, what it is
allowed to claim, when it forgets, and what an interrupted run may pick up again.

## Two invariants

Everything below follows from these:

1. **Nothing is trusted that cannot be revalidated.** Every derived fact — hash,
   media facts, perceptual signature, thumbnail — is stored with the stat
   fingerprint (`size:mtime:file_identity`) and the extractor version it was
   computed from, and is returned only while both still match. A stale row is
   simply not a cache hit; it never has to be found and deleted.
2. **Nothing is pruned on incomplete evidence.** A row is marked missing only by
   a generation that ran to completion. A cancelled, partial, or crashed scan
   leaves the catalog exactly as it found it, because *"I did not see it"* and
   *"it is not there"* are different statements and only one is safe to act on.

## Where the index lives

| Mode | Location | Why you would choose it |
|---|---|---|
| `application_data` (default) | the app's own data directory | Private to this machine, invisible to the media library, never travels |
| `portable` | beside a saved profile, at a relative filename | A moved drive keeps the expensive work already done for it |

Portable placement is validated twice — once by the profile model, once by the resolver
— and can never point inside a media tree, at an absolute path, or above the profile
directory. Nothing is ever written into the library itself.

`GET /api/catalog/diagnostics` reports location, schema version, size, the soft budget,
per-root freshness, and open generations. The budget is *reported*, never enforced:
exceeding it produces a sentence, not a deletion.

## Root freshness

| State | Meaning |
|---|---|
| `fresh` | a scan completed within the last 30 days |
| `stale` | the newest complete scan is older than that |
| `unknown` | no scan has ever completed for this root |

A root whose only scans were cancelled is `unknown`, not `fresh`. An index built from a
traversal that never finished has certified nothing.

## Rebuilding and resetting

- **Rebuild one root** (`POST /api/catalog/rebuild` with a `root_id`) drops that
  root's records and leaves every other root intact.
- **Reset the index** requires `confirm_full_reset`, because it throws away every
  hash the machine has ever computed. It deletes the database and its WAL
  siblings and nothing else — the next scan rebuilds what it needs.

Neither touches a single byte of media. The catalog is a cache: losing it costs time,
never data.

## Duplicate lookup

Exact lookup runs against the catalog's hash index in bounded pages, filtered by root
role, and always joined against the fingerprint the hash was computed from. The sort
pipeline receives a `DuplicateRegistry` whose `exact_lookup` queries that index, so a
two-million-file destination is answered from disk rather than loaded into the process.

Perceptual lookup uses the pigeonhole principle rather than a heuristic: a 64-bit
signature is split into four bands, and two signatures within Hamming distance *d* must
agree exactly on at least one band whenever *d < 4*. The band query therefore decides
only what to *examine*; every candidate's full distance is recomputed before it is
returned. When a threshold is loose enough to break that guarantee, the query reports
`degraded` and scans instead — the one thing it will not do is quietly miss pairs.
`tests/test_catalog_duplicates.py` asserts the indexed result equals an exhaustive scan
for every threshold the UI offers.

## Resume

A checkpoint records the profile, the profile and catalog schema versions, the phase,
the per-root high-water marks, and the algorithm versions in force. It is written
*after* its batch has committed: a crash between them costs one batch of repeated work,
where the reverse order would claim work that never landed.

`plan_resume` then decides, stage by stage:

| Change | Effect |
|---|---|
| different profile, profile format, or catalog schema | restart — the stored work no longer means the same thing |
| checkpoint belongs to a finished operation | start fresh |
| one algorithm version changed | that stage and everything downstream of it are redone |
| a root left the profile | discovery is redone |
| nothing changed | resume everything |

Each invalidation carries a sentence naming the actual cause, so the UI can say
*which* work is being redone instead of restarting in silence. An unreadable
checkpoint is treated as absent: the right answer to "I cannot tell what was done" is to
do it again, never to refuse to work.

## Privacy

The catalog stores paths relative to their root, stat metadata, hashes, and signatures.
It stores no media bytes and no thumbnails — only references. Support bundles tokenize
paths by default and exclude the catalog's contents entirely; see
[`observability.md`](observability.md).

## Measured behaviour at scale

`backend/tests/test_scale_benchmarks.py` generates its fixture rather than checking one
in. The default size runs in CI; `MEDIASORT_SCALE_FIXTURE` sets a larger one. The
assertions are structural — flat memory, indexed query plans, stable cursors, bounded
bind lists — because a wall-clock threshold fails on a busy machine while hiding an
O(n²) query.

Recorded on 2026-07-27, Apple Silicon (macOS 15, Python 3.14, SQLite 3.50.4, local SSD):

| Fixture | Generate + hash | Walk every record | Cursor-stability check | Whole suite |
|---:|---:|---:|---:|---:|
| 20,000 | 0.4 s | 0.1 s | <0.1 s | 1.8 s |
| 200,000 | 7.5 s | 1.9 s | 1.1 s | 12.2 s |
| **2,000,000** | **76.3 s** | **19.6 s** | **11.4 s** | **113.6 s** |

Resident growth while walking all two million records stayed under the 40 MiB assertion
— it is one batch of rows, not one library — and grouping produced its first complete
group before the scan finished. Timings scale linearly across the three sizes, which is
the property being checked; the absolute numbers are hardware-specific and are published
for comparison, not as a threshold.
