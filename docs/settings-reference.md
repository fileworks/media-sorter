# MediaSorter — Settings Reference

Every option MediaSorter exposes, what it does, and its default. Settings are edited
in the **Configure** step of the wizard (grouped into the sections below), or directly
in `config.json` in your config directory. Any field can also be overridden by an
environment variable named `MEDIASORT_<FIELD>` (e.g. `MEDIASORT_COPY_INSTEAD_OF_MOVE=true`).

> **Nothing here ever deletes your originals unless you explicitly choose the
> `delete` duplicate action.** Files that can't be placed are moved into clearly
> named quarantine folders you can review.

Defaults below are the real backend defaults from `backend/app/core/config.py`.

---

## Essentials

| Setting | Key | Default | What it does |
|---|---|---|---|
| Language | `language` | `"en"` | Interface language and language for application-generated labels in future operations: `en` or `de`. Switching is immediate and prospective; existing files, reports, user-entered names, and an operation already in progress are not translated. |
| Source folder | `source_directory` | *(required)* | The messy folder to scan. Never modified except for a `move`. |
| Destination folder | `target_directory` | *(required)* | Where the organised library is written. |
| Copy instead of move | `copy_instead_of_move` | `false` | `true` leaves your originals untouched and writes copies; `false` moves files. Copy needs enough free disk space (checked in **Analyse**). |
| Date folder levels | `sort_criteria` | `["year"]` | Folder depth of the date hierarchy: `["year"]` → `2024/`, `["year","month"]` → `2024/03/`, `["year","month","day"]` → `2024/03/15/`. |

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

## Duplicates

| Setting | Key | Default | What it does |
|---|---|---|---|
| Detect duplicates | `remove_duplicates` | `true` | Master switch for duplicate detection (per sort run). Detected duplicates are quarantined in `_duplicates/` — never deleted. |
| Exact-match duplicates | `duplicate_exact_enabled` | `true` | SHA-256 byte-identical detection. |
| Visual-similarity duplicates | `duplicate_perceptual_enabled` | `true` | Perceptual-hash near-duplicate detection (images and video). |
| Similarity threshold | `duplicate_perceptual_threshold` | `95` | 0–100; how visually similar two files must be to count as duplicates. Higher = stricter. |
| Compare against destination | `dedup_against_destination` | `false` | Index the destination's existing media (persisted across runs in a small SQLite file inside the destination) and quarantine source files already present there to `_already_in_destination/`. Also catches duplicates *between* runs (source B after source A). |
| Dedup index path | `dedup_index_path` | `null` | Override where the index database lives. `null` → `<destination>/.mediasort-dedup-index.sqlite3`. |

## Rename

| Setting | Key | Default | What it does |
|---|---|---|---|
| Rename files | `rename` | `false` | Rename each file using a pattern as it's sorted. |
| Rename pattern | `rename_pattern` | `"TYPE_YYYY-MM-DD"` | Tokens: `TYPE`, `YYYY`, `MM`, `DD`, plus a numeric counter for collisions. |
| Override existing metadata | `override_metadata` | `false` | Allow writing metadata even when the file already has some. |

## Conversion

| Setting | Key | Default | What it does |
|---|---|---|---|
| Convert videos | `convert_videos` | `false` | Transcode videos during the sort (bundled ffmpeg). |
| Video format | `video_format` | `"mp4"` | Target container: `mp4` · `mkv` · `mov` · `webm` · `avi`. |
| Convert images | `convert_images` | `false` | Transcode images during the sort. |
| Image format | `image_format` | `"jpeg"` | Target format: `jpeg` · `png` · `webp` · `tiff`. |
| Repair corrupted files | `repair_enabled` | `true` | Validate sorted files; attempt a safe repair; quarantine if unrepairable. |

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

Rules are evaluated by ascending numeric priority; equal priorities retain their saved order.
Every matching tag rule contributes its tag, while only the first matching route rule contributes
a route. Tags are de-duplicated case-insensitively in stable order before being reported or
written.

A route is a strict relative suffix such as `screenshots/mobile`. It is appended after the
normal date/category-or-source/camera hierarchy. Absolute paths, empty or dot segments,
backslashes, control characters, drive/UNC paths, and reserved device names are rejected rather
than cleaned up. Routes never apply to technical folders such as `_duplicates/`, `_junk/`,
`_failed/`, or `_already_in_destination/`.

Preview and sort share destination planning. Existing and same-batch conflicts receive
deterministic `_001`, `_002`, … suffixes without overwriting. If the destination changes after
preview, the report records the safe path actually used by sort.

Legacy `rules` arrays are migrated once to tag rules with sequential priorities. Before the
config is rewritten, MediaSorter saves `config.pre-rules-v1.json` (or a numbered variant).
Malformed entries are skipped with a warning. To roll back, close MediaSorter, replace
`config.json` with that backup, and use an older release.

## AI

AI has **two independent features** that share the same local model but do different things:

- **AI content tagging** writes descriptive *keywords into files / the report* — it does **not** move files.
- **Smart Categorization** decides *which folder a file goes in* — it writes no tags.

Use either, both, or neither.

### Local AI engine (hardware-aware)

| Setting | Key | Default | What it does |
|---|---|---|---|
| Local AI model tier | `ai_model_tier` | `"auto"` | Which local encoder to run. `auto` lets the hardware probe pick; explicit values are `lite` (CLIP ViT-B/32 — fast, runs anywhere), `standard` / `max` (SigLIP 2 — more accurate, downloads a ~100 MB model on first use), or `off`. |
| Use GPU for AI | `ai_allow_gpu` | `true` | Permit accelerator execution providers (CoreML / CUDA / DirectML). Turn off to force CPU-only. Only shown when an accelerator is detected. |

The Configure screen probes your machine (`GET /api/hardware`) and shows a **capability
chip**: your CPU/RAM/GPU summary and the recommended tier. If the machine is below the
minimum for local AI (needs ≥4 CPU cores and ≥4 GB RAM), local features auto-disable and
the UI steers you to a cloud tagging provider. Choosing a tier heavier than recommended is
allowed but flagged **"may be slow"**, so the choice is always informed.

### AI content tagging

| Setting | Key | Default | What it does |
|---|---|---|---|
| Tag media by content | `ai_tagging_enabled` | `false` | Master switch for content tagging. Runs during a real sort, not in preview. |
| Provider | `ai_tagging_provider` | `"local"` | `local` (offline, free, no key) · `azure_vision` (free 5,000/mo) · `imagga` (~1,000/mo) · `google_cloud_vision` (1,000/mo). |
| API key / secret / endpoint | `ai_tagging_api_key`, `ai_tagging_api_secret`, `ai_tagging_endpoint` | `null` | Cloud credentials. Azure needs endpoint + key; Imagga needs key + secret; Google needs key. |
| Max tags per file | `ai_tagging_max_tags` | `10` | Cap on tags written per file. |
| Tag confidence | `ai_tagging_confidence_threshold` | `0.5` | Minimum confidence (0–1) to keep a tag. For the local tagger this is how much better the label fits than a generic "a photo" background (0.5 = the natural midpoint). |
| Save tags into files | `embed_tags_in_files` | `true` | Embed deterministic and AI tags into the media (EXIF keywords for JPEG/TIFF, `keywords` for video, `.xmp` sidecar otherwise). Off = tags stay in preview/report only. The old `ai_tagging_embed_in_files` key is read for compatibility. |
| Tag labels | `ai_tagging_labels` | bundled concepts | The vocabulary the local tagger scores. Untouched bundled concepts emit localized English/German labels; editing the list marks it custom and preserves every value verbatim. |

Azure and Imagga receive the selected operation locale and request native German output. Google
Vision does not guarantee German labels, so known English results are mapped through bundled
concept aliases and unknown results are omitted with a warning. Local SigLIP uses localized
descriptions and templates. Local CLIP may use stable English semantic prompts for model quality,
but still emits the selected localized label. Provider failures remain best-effort and never fail
the sort.

### Smart Categorization

| Setting | Key | Default | What it does |
|---|---|---|---|
| Smart Categorization | `categorize_enabled` | `false` | File each photo/video into your own topic folders (`…/Y/M/D/<category>/`). Local-model only. Mutually exclusive with *Preserve source subfolders*. |
| Categories | `categorize_categories` | bundled concepts² | Untouched bundled concepts display and emit in the selected language. Editing marks the list custom; custom names remain verbatim across language changes. Works best for visually distinct topics. |
| Categorization confidence | `categorize_confidence_threshold` | `0.55` | Top-1 probability floor (0.50–0.99). Files below it go to `_uncategorized/` rather than being guessed wrong. |
| Categorization margin | `categorize_min_margin` | `0.15` | Required separation between the top and second-best category, so ambiguous files aren't force-filed. |

² Default categories: `screenshots`, `documents`, `receipts`, `food`, `nature`, `people`,
`pets`, `travel`, `events`, `sports`, `memes`.

## Other

| Setting | Key | Default | What it does |
|---|---|---|---|
| EXIF sanity check | `exif_sanity_check_enabled` | `true` | Flag dates that look bogus (e.g. a reset camera clock) as *suspicious* instead of trusting them blindly. |
| Check for updates | `update_check_enabled` | `true` | Allow the one GitHub Releases network call that powers the in-app "update available" banner. Set `false` for fully offline use. |

---

## Where things live

- **Config + database:** `~/Library/Application Support/mediasort/` (macOS) ·
  `%APPDATA%\mediasort\` (Windows). Override with `MEDIASORT_CONFIG_DIR`.
- **Logs:** see the table in the [README](../README.md#download--install).
- **Live API docs:** `http://127.0.0.1:<port>/api/docs` (OpenAPI) while the backend runs.

See [`docs/design.md`](design.md) for architecture and [`docs/development.md`](development.md)
for setup, testing, and the release flow.
