# Optimization contracts

Optimization produces a *derived* file. It is never a move, never a default, and never
enabled for a format that has not proven it can meet a written contract.

`backend/app/core/optimization_contracts.py` is the machine-readable version of this
page. Nothing here encodes media: it is the specification an encoder must later satisfy,
kept separate so the claim and the implementation cannot drift into agreeing with each
other.

## Status of every contract

| Contract | Kind | Mode | Tool (min version) | Status |
|---|---|---|---|---|
| `image-png-lossless-v1` | image | lossless | pillow ≥ 10.0.0 | **declared** |
| `image-jpeg-lossless-transcode-v1` | image | lossless | jpegtran ≥ 9e | **blocked** |
| `video-remux-lossless-v1` | video | lossless | ffmpeg ≥ 6.0 | **declared** |
| `video-h265-visually-lossless-v1` | video | visually lossless | ffmpeg ≥ 6.0 | **declared** |

- **declared** — the contract is written, but its curated fixtures have not run.
  No profile can be built and no media can be touched.
- **blocked** — additionally, a prerequisite is missing. `jpegtran` is not
  bundled, so that contract cannot be promoted on a normal install.
- **validated** — fixtures and interruption tests passed. Only this status
  allows a profile to exist, and reaching it is a deliberate code change
  accompanied by fixture results.

`enabled_contracts()` returns nothing today, and
`backend/tests/test_optimization_contracts.py` fails if that changes without the
corresponding validation work.

## What each contract promises

### `image-png-lossless-v1`

Re-compresses PNG data. Every decoded pixel, the colour mode, the bit depth, the alpha
channel, and the animation frame count are identical; only the compressed representation
changes. Textual chunks and ICC profiles carry over; no chunk is added.

| Measurement | Threshold | Why |
|---|---|---|
| `decoded_pixels_identical` | must be true | A lossless claim is false if any pixel differs |
| `dimensions_identical` | must be true | Resizing is a different operation, never an optimization |
| `size_reduction_ratio` | ≥ 2% | Below that the rewrite costs more than it saves |

Cost: recompressed PNGs are byte-different, so external checksums and dedup indexes
covering the original will no longer match.

### `image-jpeg-lossless-transcode-v1`

Rearranges DCT coefficients (progressive rescan) without re-quantizing, so the decoded
image is bit-identical. EXIF, ICC, and XMP segments copy verbatim. Typical saving is
2–10%. Progressive JPEG decodes more slowly on some embedded viewers. Blocked:
`jpegtran` is not bundled.

### `video-remux-lossless-v1`

Copies every video, audio, and subtitle stream into a new container without re-encoding.
Decoded content is unchanged by construction.

| Measurement | Threshold | Why |
|---|---|---|
| `stream_count_identical` | must be true | A dropped audio or subtitle track is data loss |
| `duration_delta_seconds` | ≤ 0.04 | One frame at 25fps — container timebase rounding only |
| `codec_identical` | must be true | A codec change means this was not a remux |

Cost: MP4 cannot carry every codec an MKV can. Unsupported inputs must be skipped, never
re-encoded as a fallback.

### `video-h265-visually-lossless-v1`

**This is lossy encoding.** Decoded content differs from the original. The
contract asserts only that sampled objective measurements met the thresholds below —
never that a person cannot tell.

| Measurement | Threshold | Why |
|---|---|---|
| `vmaf_mean` (sampled frames) | ≥ 95.0 | The widely cited visually-lossless band starts near 95; below it differences become findable in side-by-side review |
| `vmaf_minimum` (sampled frames) | ≥ 88.0 | A good mean must not hide one badly degraded scene |
| `duration_delta_seconds` | ≤ 0.04 | Timeline drift is a correctness bug, not a quality one |
| `size_reduction_ratio` | ≥ 25% | Lossy re-encoding is only worth its risk at real savings |

Costs, all of which must be shown before the user accepts:

- HEVC playback is not universal on older devices and browsers.
- HDR and 10-bit sources need their own fixtures before enabling.
- Re-encoding is irreversible; the original stays in quarantine.

## How a profile comes to exist

`build_optimization_profile(contract_id, acknowledged=...)` refuses, in order:

1. a contract that is not `validated`;
2. a caller that has not passed an explicit acknowledgement;
3. a tool that is missing, or whose version cannot be probed.

Each refusal raises `OptimizationUnavailableError` rather than producing a profile that
silently does nothing. A profile that *is* built records the tool, the probed tool
version, the exact parameter set, the resource limits, and `retain_original=True` —
enough to reproduce the run and to undo it.

## Wording rules

Passing is reported as **"met configured checks"**. It is never reported as "identical",
"lossless" (for the lossy profile), or "indistinguishable". A sample comparison is
labelled with the exact item, tool, and settings that produced it, and never stands in
for per-output validation of the whole batch.

## Preview: what is measured, and what is only projected

`app/services/optimization_preview.py` encodes a **bounded sample** — smallest, median,
and largest eligible item, inside a byte budget — and projects the rest of the selection
from it. Each item's projection carries its own confidence:

| Confidence | Means | Shown as |
|---|---|---|
| `measured` | this exact file was encoded | one number |
| `sampled` | projected from encodes of this library | a range |
| `unknown` | no representative encode succeeded | no number, plus the reason |

Aggregates take the *weakest* contributing confidence, so one unmeasurable item
downgrades the summary rather than disappearing into an average. An item whose
projection is a size *increase* is recommended for skipping and needs an explicit
override; an item whose sample failed its contract is blocked outright.

Without a retained workspace the candidates are discarded and the projection reports
`estimate_only`, which is what stops the UI from offering a comparison that has nothing
behind it.

## Execution: stage, prove, commit, quarantine

`app/services/optimization_execution.py` runs `preflight` once per batch — it refuses a
disabled profile, an unvalidated contract, a missing acknowledgement, a missing tool, an
encoder build different from the one the plan was projected with, and any input outside
the contract's formats — before a single original is read. Each accepted file then goes
through:

1. **stage** — encode beside the original into a private staging directory;
2. **validate** — decode the written file again, hash it, compare metadata
   policy, and evaluate every declared metric independently of the encoder;
3. **commit** — only when `passed is True`. `passed is None` (a threshold that
   could not be measured) is an `indeterminate` rejection, never a pass;
4. **quarantine** — the original moves into managed quarantine *before* the
   output is published, with a restore relation to its replacement.

The worst case at any interruption is therefore a file in quarantine with a record
pointing at it — never a file that is gone.

## Quarantine and restore

`app/services/quarantine.py` keeps an append-only JSON Lines record per moved original:
original path, identity, hash, reason, keeper link, operation, and retention state.
`preview_restore` reports the target, any conflict, whether the quarantined bytes still
match their recorded hash, and why a restore is blocked — before anything moves. A
conflict at the original path is never resolved by overwriting: the caller picks an
alternate path or skips.

## The release gate

`backend/tests/test_optimization_fixtures.py` generates the curated corpus (ordinary,
1×1, flat alpha, 16-bit, metadata-bearing, animated, truncated) and fails the build if
any contract is marked `validated` without passing it. The corpus already caught one
real defect: a plain Pillow save drops every PNG text chunk and the ICC profile, which
the encoder now carries forward explicitly and reports as a warning when it cannot.
