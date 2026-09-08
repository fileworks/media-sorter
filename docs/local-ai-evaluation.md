# Local tagging and organization: evidence and next evaluation

Research checked 2026-09-06; CPU-only smoke evaluation run 2026-09-07.
Recommendations below are candidates for evaluation, not claims about accuracy on
a personal library. The pinned SigLIP pack and four public sample images were
downloaded into disposable storage. No personal media was read or uploaded.

## Product direction

The owner's workflow starts with consolidating scattered folders, then becomes
regular imports into the same library. Organization and importing therefore share
one Copy-first recipe, with year/month folders and original filenames. Renaming,
preserving existing event/album subfolders, and rule-based routing remain optional.
Cleanup is a separate, explicitly consequential job: only unwanted copies and
junk move out of an already organized library. References always remain immutable.

Exact and similar sets can be reviewed individually or accepted in bulk where a
keeper can be proposed. A visual match is never sufficient authority to remove
anything without the user's explicit decision. Missing material evidence remains
an unresolved set, not an excuse to guess. AI must never authorize removal.

## What the implementation actually provides

`encoder_factory.py` maps Lite to CLIP ViT-B/32 and both Standard and Max to the
same quantized SigLIP 2 base/16 256-pixel encoder, with the same acceleration
setting. Max is not a higher-quality model. The bundled manifest contains about
608 MB for CLIP and 413 MB for SigLIP, including text towers and tokenizers;
these are download sizes, not RAM requirements. The interface uses the manifest
inventory instead of invented tier-size estimates.

The tagger already uses independent multi-label scores, prompt ensembling,
localized bundled concepts and background anchors. Categorization has both a
score and margin gate and an uncategorized fallback. These scores are not
calibrated probabilities of a label being correct. Do not tune them by intuition
or imply that a 99% threshold means 99% accuracy.

Model selection, explicit installation, Auto/Off and GPU controls now share one
visible setup block. Neither tagging nor categorization must be enabled just to
install its model. Installing a pack is not permission to enable either feature.
Failed hardware detection is announced with a retry action, not an indefinite
loading message.

A generated JPEG exposed a real metadata bug: SceneCaptureType was read from
IFD0 instead of the Exif sub-IFD. The regression tests use actual encoded EXIF,
verify English/German output and leave source bytes unchanged. Camera scene mode
is still only recorded metadata; nearest-city reverse geocoding is approximate.

## Candidates, using primary sources

- **Keep SigLIP 2 as the baseline.** Google's research describes multilingual
  image/text encoders with zero-shot classification and retrieval improvements.
  Larger-resolution and native-aspect-ratio variants are plausible candidates,
  especially for detail-sensitive images, but would need different preprocessing,
  measured costs and newly pinned artifacts. The app already has the base model;
  merely recommending SigLIP 2 is not an implementation improvement.
  [Google research and checkpoint comparisons](https://google-research.github.io/big_vision/big_vision/configs/proj/image_text/README_siglip2.html).
- **Benchmark MobileCLIP2 for a lighter encoder.** Apple's repository reports
  accuracy/latency trade-offs and supplies evaluation code. Its reported mobile
  results do not establish MediaSorter desktop performance, German label quality,
  or an advantage over the app's quantized SigLIP export. Evaluate the whole
  image/text pipeline, not just the image encoder. Packaging also requires a
  reviewed model license and a pinned safe-format export; do not directly load
  arbitrary upstream pickle checkpoints.
  [Apple's implementation and evaluation instructions](https://github.com/apple/ml-mobileclip).
- **Evaluate a small local VLM only as a second pass.** Qwen3.5-4B is an
  image-to-text model distributed as safetensors under Apache-2.0. It is a
  candidate for richer descriptions or uncertain-image review, not a drop-in
  encoder replacement. A second pass would need bounded output, cancellation,
  independent hallucination evaluation and strict separation from file actions.
  A generated description must not invent event names, people or capture dates.
  [Qwen's model card](https://huggingface.co/Qwen/Qwen3.5-4B).

## Evaluation required before changing the model or claiming quality

Use an explicitly approved, read-only representative sample, with separate
calibration and held-out sets. Include photos, videos, screenshots, scanned
documents, pets, food, low light, rotations, RAW/HEIC and out-of-vocabulary scenes.
Near-duplicate images must stay in the same split to avoid evaluation leakage.
Human labels must distinguish visible facts from guesses and include acceptable
abstention and ambiguous categories.

Measure tag precision/recall and unsupported-tag rate; routing precision and
coverage (including uncategorized results); English/German semantic consistency;
cold and warm p50/p95 latency; peak process memory; model-load cost; video cost;
and cancellation latency while review thumbnails are active. Report hardware,
provider, model revision, quantization, prompts and thresholds with every result.
Choose the acceptable precision/coverage trade-off from those results, not a
generic benchmark ranking. A model change must retain pinned hashes, offline
inference, safe artifacts and the existing frozen-plan/transfer guards.

## CPU-only smoke evidence, not a quality benchmark

The hardware target is inexpensive laptops through mid-range PCs, without a
dedicated accelerator requirement. The development machine is an Apple M3 Pro,
12 cores, 18 GiB RAM, macOS 26.6.2. It is **not** evidence of low-end laptop speed.
The existing pinned quantized SigLIP pack was verified by the production installer
and loaded with `allow_gpu=False` / `CPUExecutionProvider`. Socket connection
attempts were made fatal during inference. All source SHA-256 values were
unchanged afterward.

The four samples are scikit-image v0.25.2's astronaut, Chelsea, coffee and rocket:
public-domain NASA/SpaceX images and CC0 photographs by Stefan van der Walt and
Rachel Michetti. Their upstream documentation records the source and license.
[Sample provenance](https://scikit-image.org/docs/stable/api/skimage.data.html).
They are recognizable smoke fixtures, not a representative, held-out evaluation
set; training overlap is unknown.

With default bundled vocabularies and thresholds in English and German:

- Model loading took 1.75 s; peak process RSS was 2.58 GB (decimal).
- First tagging, including text-vocabulary encoding, took 6.77 s in English and
  5.48 s in German. Five warm repetitions per image/language had per-case medians
  of 41–64 ms. These exclude decoding and are not end-to-end import throughput.
- Cat and drink labels appeared, but the coffee image also received **boat** in
  English and the astronaut portrait received **selfie** in both languages.
  A score is plainly not a probability of correctness.
- Categorization abstained on all eight image/language cases. That preserves the
  fallback rather than silently routing uncertain images, but it does not prove
  useful routing coverage.

A **non-shipped** experiment split text inference into batches of 16. Peak RSS
dropped to 1.18 GB; first tagging took 4.52 s / 3.74 s. However, scores and some
accepted labels changed, including new unsupported German coffee tags. Therefore
this is not treated as a behavior-preserving memory optimization. The production
encoder, model, thresholds and batching remain unchanged. Memory tuning needs a
representative quality comparison, not just a lower RSS measurement.

The four-step shell is implemented: Sources → Setup → Review → Execute, with
optional adjustments inside Setup and an impact summary inside Review. Automatic
event inference is not implemented; existing subfolder preservation and explicit
rules remain available. AI remains optional and off by default. Existing
conversion/repair controls have not been promoted as newly validated quality
features. Before promoting AI, evaluate a representative read-only library and
the low-end CPU/RAM tier, including RAW/HEIC, video, cancellation and concurrent
thumbnail delivery.

## Expanded public-media verification — 2026-09-07

A second evaluation used 32 visually inspected Wikimedia Commons JPEGs (eight
each of nature, landmarks, people and animals), two CC0 camera RAW files from
raw.pixls.us, and a 25-second waterfall WebM. The collection, source credits,
hashes and evaluation logs are kept outside the repository. It is a curated
smoke set, not a held-out representative library or a precision/recall benchmark.

The same pinned SigLIP encoder ran through the production file-tagging and
categorization services in both languages, with CPU-only execution, fatal socket
connection attempts and unchanged source hashes. All 70 file/language cases
completed without a network attempt. RAW flower and food subjects and the
waterfall video produced relevant tags, but unsupported tags remain: an English
sleeping-cat image received `map`, a dog received `selfie`, and German castle
output included `Haustier` and `Innenaufnahme`. These are demonstrated quality
failures, not merely unverified quality. Categorization accepted only one of 35
English cases (`pets` for the dog) and none of the 35 German cases at defaults.
Do not promote this configuration as reliable automatic topical organization.

On the same M3 Pro, model load was 1.79 seconds and peak process RSS was 2.71 GB
(decimal). Excluding the first vocabulary-initializing JPEG in each language,
per-file JPEG tagging p50/p95 were 130/302 ms in English and 130/283 ms in German,
including file decoding. These are single-pass timings, not repeated warm-cache
throughput. Video tagging took about 4.1–4.3 seconds per language. No low-end
hardware performance or optimization claim follows from these numbers.

Two real API preview → approved-plan → Copy → report runs each copied all 35
files without failures or byte changes. Report-only storage produced no sidecars;
explicit `sidecar_and_report` produced 32 parseable, nonempty XMP sidecars (three
files had no tags). The UI previously called report-only storage “XMP sidecar
files”; it now exposes all three actual storage policies and keeps embedded-edit
permissions unchanged. A second UI fix preserves custom tag capitalization.
English/German unit tests, browser storage-choice checks and a config API
round-trip test hold these rules. AI setup now explicitly cautions that outputs
can be wrong and scores are not accuracy guarantees. Model weights, prompts,
thresholds, batching and off-by-default settings are unchanged.

Follow-up safety verification found that the existing sidecar writer could
overwrite an occupied XMP path, including through a symlink. It now stages a
complete, flushed sidecar and uses shared no-clobber publication. Existing XMP
is preserved; generated tags remain in the report on a conflict. Regression
tests cover regular-file and symlink collisions and cleanup after interruption.
