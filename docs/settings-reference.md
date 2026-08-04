# MediaSorter — Settings Reference

Every option MediaSorter exposes, what it does, and its default. Settings are edited on
the **Sources** stage (grouped into the sections below), or directly in `config.json` in
your config directory. Any field can also be overridden by an environment variable named
`MEDIASORT_<FIELD>` (e.g. `MEDIASORT_COPY_INSTEAD_OF_MOVE=true`).

> **Duplicates are never deleted.** Files that cannot be placed are moved into
> clearly named quarantine folders you can review.

Defaults below are the real backend defaults from `backend/app/core/config.py`.

## Recipes and visibility

Recipes are starting points, not modes. Applying one writes ordinary configuration
fields, reports the exact keys it changed, and leaves every field editable. A recipe
never reaches into a folder, a credential or a vocabulary, which is what makes it
reusable across libraries.

| Recipe | Fields it establishes | Consequence stated before applying |
|---|---|---|
| **Safe Sort** *(recommended)* | copy, year/month folders, exact + near duplicate review, no junk filter, no conversion | Nothing in the input folder moves and nothing anywhere is rewritten |
| **Clean Sweep** | move, year/month folders, duplicates and junk parked in review folders | Originals leave the input folder — after each file has been verified |
| **Archive & Convert** | copy, duplicates and junk, JPEG/MP4 conversion, repair | Rewrites image and video bytes; requires a reviewed mutation profile |
| **Start from scratch** | everything off, including duplicate detection | A clean slate to build a recipe on |

### Saved recipes

A user can name the current run behaviour and reuse it later.

| Endpoint | What it does |
|---|---|
| `GET /api/config/recipes` | The user's own recipes, most recent first |
| `POST /api/config/recipes` | Save under a name; saving over an existing name replaces it |
| `DELETE /api/config/recipes/{recipe_id}` | Forget one; deleting an absent id is not an error |

Stored on `Config.saved_recipes` as `SavedRecipe` records
(`backend/app/core/recipes.py`). The captured slice is an explicit `RecipeSettings`
model rather than a free-form mapping, so the round trip stays typed and a recipe
written by an older build loads with the current defaults filled in. At most 50 recipes;
names are whitespace-collapsed, at most 60 characters, and may not shadow a built-in id.

### Where settings appear

The Configure screen groups every setting into three numbered cards in the order the
work happens: **01 Sort** (how files travel and land) → **02 Clean** (duplicates and
junk) → **03 Enrich** (convert and tag). The rail beside them carries the *current
value* of each entry, so reading it top to bottom answers "what is this run going to
do?" without expanding anything.

Consequential detail — cloud credentials, label vocabularies, thresholds, rule editing —
sits behind a per-row disclosure. A new setting belongs in a disclosure unless its value
is normally decided for each run or library.

## Essentials

| Setting | Key | Default | What it does |
|---|---|---|---|
| What the run is for | `run_mode` | `"organize"` | `organize` places every file into the destination structure. `deduplicate_only` moves **nothing but duplicates and junk** — the input tree is left exactly as found and the destination is used only for the review folders. |
| Organise into date folders | `sort` | `true` | `false` runs the scan and the reviews without producing any placement. |
| Language | `language` | `"en"` | Interface language and language for application-generated labels in future operations: `en` or `de`. Switching is immediate and prospective; existing files, reports, user-entered names, and an operation already in progress are not translated. |
| Source folder | `source_directory` | *(required)* | The messy folder to scan. Never modified except for a `move`. |
| Destination folder | `target_directory` | *(required)* | Where the organised library is written. |
| Copy instead of move | `copy_instead_of_move` | `false` | `true` leaves your originals untouched and writes copies; `false` moves files. Copy needs enough free disk space (checked in **Analyse**). |
| Companion media | `companion_handling` | `"keep_with_primary"` | `keep_with_primary` binds recognized sidecars, Live Photo motion, RAW siblings, video thumbnails, and audio notes into one unit. `leave_in_place` reports the split and transfers only the primary. `ignore` reproduces media-only behavior. Override with `MEDIASORT_COMPANION_HANDLING`. |
| Date folder levels | `sort_criteria` | `["year"]` | Folder depth of the date hierarchy: `["year"]` → `2024/`, `["year","month"]` → `2024/03/`, `["year","month","day"]` → `2024/03/15/`. |

### Media units

Pairing requires the same directory and a matching stem. A fixed primary precedence is
used: RAW, HEIC/HEIF, JPEG, other image, then video. Recognized roles are edit sidecars
(`.xmp`, `.aae`, `.pp3`, `.dop`, `.on1`, `.reastore`), Live Photo `.mov`, RAW+JPEG/HEIC
siblings, video `.thm`, and image `.wav` notes.

Only the primary drives date extraction, routing, renaming, and duplicate evaluation.
Every companion inherits the primary's final folder and collision suffix but keeps its
own extension. Preview lists the binding and warns before commit about unmatched files,
`leave_in_place`, and conversion. Conversion does not rewrite an internal filename
reference inside a companion.

## Folders & routing

| Setting | Key | Default | What it does |
|---|---|---|---|
| Scan subfolders | `recursive_scan` | `true` | Descend into subdirectories of the source folder. |
| Max scan depth | `max_recursion_depth` | `null` | How deep to recurse. `null` = unlimited. |
| Preserve source subfolders | `preserve_subfolders` | `false` | `true` recreates the original subfolder tree under each date folder; `false` flattens into the date folder. Mutually exclusive with Smart Categorization. |
| Group by camera model | `camera_subfolder_enabled` | `false` | Adds a per-camera subfolder (`…/Y/M/D/<category>/<camera>/`) using EXIF camera model. |
| Excluded patterns | `exclude_patterns` | system junk¹ | Glob patterns (relative to the source root) to skip. |

¹ Defaults skip common OS/NAS clutter: `@eaDir`, `.@__thumb`, `@Recycle`, `Thumbs.db`,
`desktop.ini`, `.DS_Store`, `.Spotlight-V100`, `eaRecycle`.

## Filters

| Setting | Key | Default | What it does |
|---|---|---|---|
| Min file size (KB) | `min_file_size_kb` | `null` | Skip files smaller than this. `null` = no minimum. |
| Max file size (MB) | `max_file_size_mb` | `null` | Skip files larger than this. `null` = no maximum. |
| Junk / thumbnail filter | `junk_filter_enabled` | `false` | Quarantine thumbnails and cache debris to `_junk/` (never deletes). Recommended for messy phone/HDD dumps. |
| Junk size floor (KB) | `junk_min_file_size_kb` | `8` | Files smaller than this are junk. `0` disables the size check. |
| Junk resolution floor (px) | `junk_min_image_dimension` | `200` | Images whose *shorter* side is under this are junk. `0` disables. |
| Junk name patterns | `junk_filename_patterns` | thumbnails² | Shell globs matched against the filename and every parent folder name. |

² Defaults: `Thumbs.db`, `ehthumbs.db`, `desktop.ini`, `._*`, `*-thumb.*`, `*_thumb.*`,
`.thumbnails`, `.thumbs`.

## Thumbnail cache

| Setting | Key | Default | What it does |
|---|---|---|---|
| Cache thumbnails | `thumbnail_cache_enabled` | `true` | Reuses rendered previews instead of decoding the source again. Disable it to render on demand without creating cache entries. |
| Cache budget | `thumbnail_cache_budget_bytes` | `536870912` (512 MiB) | Fixed byte ceiling. Least-recently-used entries are removed opportunistically on a write; there is no timer or idle worker. |

The cache lives at `<data directory>/thumbnail-cache/`. Its keys include source
identity, sampled content, requested size, and renderer version. It contains only
derived JPEG previews and is safe to delete at any time; the next visible request
regenerates what it needs. Read, write, permission, full-disk, and corrupt-entry
failures fall back to on-demand rendering and never block media access.

## Duplicates

| Setting | Key | Default | What it does |
|---|---|---|---|
| Detect duplicates | `remove_duplicates` | `true` | Master switch for duplicate detection (per sort run). Detected duplicates are quarantined in `_duplicates/` — never deleted. |
| Exact-match duplicates | `duplicate_exact_enabled` | `true` | SHA-256 byte-identical detection. |
| Visual-similarity duplicates | `duplicate_perceptual_enabled` | `true` | Perceptual-hash near-duplicate detection (images and video). |
| Similarity threshold | `duplicate_perceptual_threshold` | `95` | 0–100; how visually similar two files must be to count as duplicates. Higher = stricter. |
| Default keep rule | `duplicate_keeper_policy` | `"best_quality"` | Which copy a group keeps when nobody has chosen one by hand: `best_quality` (most pixels, then largest) · `largest` · `smallest` · `newest` · `oldest` · `highest_resolution` · `longest_filename` · `shortest_filename` · `manual`. A *default* — Review overrides it per group or in bulk, and a protected reference member always wins regardless. `highest_resolution` refuses a group whose dimensions could not all be read; `best_quality` falls back to size for those. |
| Dedup index path | `dedup_index_path` | `null` | Override where the index database lives. `null` → `<destination>/.mediasort-dedup-index.sqlite3`. |

When duplicate detection is enabled, MediaSorter always compares source files with
existing destination media before checking duplicates within the current source.
Destination matches are quarantined to `_already_in_destination/`; the index also
catches duplicates across separate runs. Preview performs the same comparison through a
temporary read-only index. A legacy `dedup_against_destination` value is accepted when
loading old config files but is ignored and is not saved.

## Photo bursts

Off by default, and separate from duplicate detection: burst frames are legitimate
alternatives, not redundant copies. A group forms only when capture time, a
burst-specific perceptual distance, and camera identity all agree.

| Setting | Key | Default | What it does |
|---|---|---|---|
| Detect bursts | `burst_detection_enabled` | `false` | Master switch. When off, none of the metadata, perceptual, or sharpness work runs. |
| Time window | `burst_time_window_seconds` | `3.0` | How close consecutive captures must be to be considered one burst. |
| Perceptual distance | `burst_perceptual_distance` | `4` | Maximum hash distance, in bits. Tighter than, and independent of, similar-media matching. |
| Same camera required | `burst_require_camera_identity` | `true` | Require identical camera make and model. Turning this off is how two devices photographing one scene get grouped. |

Every burst group waits for a person; nothing is acted on before review. See
`burst-review.md` for the calibration corpus behind the defaults.

## Rename

| Setting | Key | Default | What it does |
|---|---|---|---|
| Rename files | `rename` | `false` | Rename each file using a pattern as it's sorted. |
| Rename pattern | `rename_pattern` | `"TYPE_YYYY-MM-DD"` | Tokens: `TYPE`, `YYYY`, `MM`, `DD`, plus a numeric counter for collisions. |
| Override existing metadata | `override_metadata` | `false` | Rewrite the embedded creation date. Changes media bytes, so it needs a reviewed mutation profile — see [Media mutation profiles](#media-mutation-profiles). |

## Conversion

| Setting | Key | Default | What it does |
|---|---|---|---|
| Convert videos | `convert_videos` | `false` | Transcode videos during the sort (bundled ffmpeg). Needs a reviewed mutation profile plus an acknowledged optimization profile. |
| Video format | `video_format` | `"mp4"` | Target container: `mp4` · `mkv` · `mov` · `webm` · `avi`. |
| Video quality | `video_quality` | `"medium"` | `low` · `medium` · `high`, mapped to a CRF by the converter. |
| Convert images | `convert_images` | `false` | Transcode images during the sort. Needs a reviewed mutation profile plus an acknowledged optimization profile. |
| Image format | `image_format` | `"jpeg"` | Target format: `jpeg` · `png` · `webp` · `tiff`. |
| Image quality | `image_quality` | `90` | 60–100, for lossy formats only (JPEG/WebP); ignored by PNG and TIFF. The floor is not 1: below roughly 60 the artefacts are visible on any photograph, and a setting that only produces bad output is a trap rather than a choice. Validated only while image conversion is on. |
| Repair corrupted files | `repair_enabled` | `true` | Validate sorted files; attempt a safe repair; quarantine if unrepairable. Repair rewrites media, so it needs a reviewed mutation profile. |

## Library roots

A profile holds several typed roots, each with one role:

| Role | Count | What it means |
|---|---|---|
| `input` | one or more | Folders to organize. Every one is enumerated; each file keeps its own root for relative layout and quarantine structure |
| `reference` | any | Compared against, **never changed**. Used to deduplicate against a library you do not want reorganized |
| `destination` | exactly one | Where organized media lands |

Copy/Move is profile-wide: it is one decision for the run, not per root.

Each root carries its own `exclusions` — relative subtrees skipped for that root only. A
root that is offline or unreadable contributes a partial-result issue and the remaining
roots still run; one disconnected drive never fails the operation.

**Reference roots are enforced, not just documented.** The verified executor
refuses any transfer whose source or destination falls inside one, with
`MUTATION_NOT_AUTHORIZED` / `reference_root_is_immutable`, and records an
`integrity.violation` event. Because the check lives at the single point where media
moves, no pipeline step can bypass it by forgetting to look.

## Media mutation profiles

MediaSorter organizes by default and mutates only when asked. Two profiles carry that
authorization; both are stored in `config.json` and validated before any preview or sort
starts.

### `preservation_profile`

| Field | Default | What it does |
|---|---|---|
| `mode` | `"organize_only"` | `organize_only` copies and moves media byte-for-byte. `explicit_mutation` is the only mode that can authorize a media rewrite. |
| `allow_embedded_metadata_edits` | `false` | Permits EXIF/tag writes into the file (`override_metadata`, `embed_tags_in_files`). |
| `allow_repair` | `false` | Permits `repair_enabled` to rewrite a file. |
| `allow_conversion` / `allow_compression` | `false` | Permit `convert_images` / `convert_videos`. |
| `preserve_filesystem_timestamps` | `true` | Copies the original atime/mtime to the destination. Set to `false` to write the extracted media date instead. |
| `derived_metadata` | `"report_only"` | Where derived tags and date corrections go when they are not embedded. `sidecar_and_report` also writes a `<file>.xmp` sidecar. |
| `acknowledged_at` | `null` | Timestamp of the explicit acknowledgement. `explicit_mutation` without it is refused. |
| `requires_review` | `false` | Set by migration when an older config already enabled mutating settings. Blocks execution until reviewed. |

### `optimization_profile`

Conversion additionally needs an acknowledged optimization profile naming its `tool`,
`tool_version`, and `validation_contract`; compression requires `mode:
"visually_lossless"`. A disabled profile cannot carry any execution authorization.

### What happens without one

Turning on a mutating setting under Organize Only does not silently downgrade the run —
it is refused with `MUTATION_NOT_AUTHORIZED` and a `reason` naming the missing
authorization (`explicit_profile_required`, `capability_not_authorized`,
`optimization_profile_required`, `compression_profile_required`, or
`migration_review_required`). Nothing is written before the refusal.

## Rules (tagging and routing)

| Setting | Key | Default | What it does |
|---|---|---|---|
| Rules enabled | `rules_enabled` | `true` | Global switch for deterministic rules. Each rule also has its own `enabled` switch. |
| Version | `rule_set.version` | `1` | Version of the strict rule model. Unknown future versions are rejected and never silently rewritten. |
| Tag rules | `rule_set.tag_rules` | `[]` | Ordered tag rules with stable IDs, names, priorities, typed conditions, and a `tag` value. |
| Route rules | `rule_set.route_rules` | `[]` | Ordered route rules with stable IDs, names, priorities, typed conditions, and a `relative_folder` suffix. |

Conditions inspect the **source** file before conversion or renaming:

- `extension` uses the final suffix (`archive.tar.jpg` → `jpg`).
- `filename_contains` searches the filename stem with Unicode-aware, case-insensitive matching.
- `size` compares source bytes with `eq`, `gt`, `lt`, `gte`, or `lte`.
- `resolution` compares source width and height with the same operators.

Rules are evaluated by ascending numeric priority; equal priorities retain their saved
order. Every matching tag rule contributes its tag, while only the first matching route
rule contributes a route. Tags are de-duplicated case-insensitively in stable order
before being reported or written.

A route is a strict relative suffix such as `screenshots/mobile`. It is appended after
the normal date/category-or-source/camera hierarchy. Absolute paths, empty or dot
segments, backslashes, control characters, drive/UNC paths, and reserved device names
are rejected rather than cleaned up. Routes never apply to technical folders such as
`_duplicates/`, `_junk/`, `_failed/`, or `_already_in_destination/`.

Preview and sort share destination planning. Existing and same-batch conflicts receive
deterministic `_001`, `_002`, … suffixes without overwriting. If the destination changes
after preview, the report records the safe path actually used by sort.

Legacy `rules` arrays are migrated once to tag rules with sequential priorities. Before
the config is rewritten, MediaSorter saves `config.pre-rules-v1.json` (or a numbered
variant). Malformed entries are skipped with a warning. To roll back, close MediaSorter,
replace `config.json` with that backup, and use an older release.

## AI

AI has **two independent features** that share the same local model but do different
things:

- **AI content tagging** writes descriptive *keywords into files / the report* — it does **not** move files.
- **Smart Categorization** decides *which folder a file goes in* — it writes no tags.

Use either, both, or neither.

### Local AI engine (hardware-aware)

| Setting | Key | Default | What it does |
|---|---|---|---|
| Local AI model tier | `ai_model_tier` | `"auto"` | Which local encoder to run. `auto` lets the hardware probe pick; explicit values are `lite` (CLIP ViT-B/32 — fast, runs anywhere), `standard` / `max` (SigLIP 2 — more accurate), or `off`. The selected model pack is installed explicitly, verified before publication, and loaded into memory only when first used. |
| Use GPU for AI | `ai_allow_gpu` | `true` | Permit accelerator execution providers (CoreML / CUDA / DirectML). Turn off to force CPU-only. Only shown when an accelerator is detected. |

The Configure screen probes your machine (`GET /api/hardware`) and shows a **capability
chip**: your CPU/RAM/GPU summary and the recommended tier. If the machine is below the
minimum for local AI (needs ≥4 CPU cores and ≥4 GB RAM), local features auto-disable and
the UI steers you to a cloud tagging provider. Choosing a tier heavier than recommended
is allowed but flagged **"may be slow"**, so the choice is always informed.

### AI content tagging

| Setting | Key | Default | What it does |
|---|---|---|---|
| Tag media by content | `ai_tagging_enabled` | `false` | Master switch for content tagging. Runs during a real sort, not in preview. |
| Provider | `ai_tagging_provider` | `"local"` | `local` (offline, free, no key) · `azure_vision` (free 5,000/mo) · `imagga` (~1,000/mo) · `google_cloud_vision` (1,000/mo). |
| API key / secret / endpoint | `ai_tagging_api_key`, `ai_tagging_api_secret`, `ai_tagging_endpoint` | `null` | Cloud credentials. Azure needs endpoint + key; Imagga needs key + secret; Google needs key. |
| Max tags per file | `ai_tagging_max_tags` | `10` | Cap on tags written per file. |
| Tag confidence | `ai_tagging_confidence_threshold` | `0.5` | Minimum confidence (0–1) to keep a tag. For the local tagger this is how much better the label fits than a generic "a photo" background (0.5 = the natural midpoint). |
| Save tags into files | `embed_tags_in_files` | `true` | Embed deterministic and AI tags into the media (EXIF keywords for JPEG/TIFF, `keywords` for video, `.xmp` sidecar otherwise). Embedding rewrites the file, so it needs a reviewed mutation profile. Off = tags go to the report, plus an `.xmp` sidecar when the preservation profile asks for one. The old `ai_tagging_embed_in_files` key is read for compatibility. |
| Tag labels | `ai_tagging_labels` | bundled concepts | The vocabulary the local tagger scores. Untouched bundled concepts emit localized English/German labels; editing the list marks it custom and preserves every value verbatim. |

Azure and Imagga receive the selected operation locale and request native German output.
Google Vision does not guarantee German labels, so known English results are mapped
through bundled concept aliases and unknown results are omitted with a warning. Local
SigLIP uses localized descriptions and templates. Local CLIP may use stable English
semantic prompts for model quality, but still emits the selected localized label.
Provider failures remain best-effort and never fail the sort.

### Smart Categorization

| Setting | Key | Default | What it does |
|---|---|---|---|
| Smart Categorization | `categorize_enabled` | `false` | File each photo/video into your own topic folders (`…/Y/M/D/<category>/`). Local-model only. Mutually exclusive with *Preserve source subfolders*. |
| Categories | `categorize_categories` | bundled concepts² | Untouched bundled concepts display and emit in the selected language. Editing marks the list custom; custom names remain verbatim across language changes. Works best for visually distinct topics. |
| Categorization confidence | `categorize_confidence_threshold` | `0.55` | Top-1 probability floor (0.50–0.99). Files below it go to `_uncategorized/` rather than being guessed wrong. |
| Categorization margin | `categorize_min_margin` | `0.15` | Required separation between the top and second-best category, so ambiguous files aren't force-filed. |

² Default categories: `screenshots`, `documents`, `receipts`, `food`, `nature`,
`people`, `pets`, `travel`, `events`, `sports`, `memes`.

## Other

| Setting | Key | Default | What it does |
|---|---|---|---|
| EXIF sanity check | `exif_sanity_check_enabled` | `true` | Flag dates that look bogus (e.g. a reset camera clock) as *suspicious* instead of trusting them blindly. |
| Check for updates | `update_check_enabled` | `true` | Allow the one GitHub Releases network call that powers the in-app "update available" banner. Set `false` for fully offline use. |

## Fields this page deliberately omits

`library_profile`, `rule_set` and `saved_recipes` are structures with their own sections
above rather than single settings. `migrated_legacy_rules`, `migration_warnings`,
`ai_tagging_labels_provenance` and `categorize_categories_provenance` are state the
loader maintains, not choices anybody makes.

`analyze` is a persisted field that nothing reads — it survives in the schema but has no
effect. It is listed here so its absence from the tables above is not mistaken for an
oversight.

## Where things live

- **Config, database, and logs:** use distinct platform config/data/log
  semantics with `MEDIASORT_CONFIG_DIR`, `MEDIASORT_DATA_DIR`,
  `MEDIASORT_DB_PATH`, and `MEDIASORT_LOG_DIR` overrides. Exact current,
  historical, conflict, and recovery paths are in
  [state-and-recovery.md](state-and-recovery.md).
- **Backend logs:** the JSON log rotates at 5 MiB and retains three backups plus
  the active file, so backend retention is at most about 20 MiB.
- **Live API docs:** `http://127.0.0.1:<port>/api/docs` (OpenAPI) while the backend runs.

See [`docs/design.md`](design.md) for architecture and
[`docs/development.md`](development.md) for setup, testing, and the release flow.
