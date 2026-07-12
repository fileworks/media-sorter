---
name: router
description: Session bootstrap and navigation hub. Read at the start of every session before any task. Contains project state, routing table, and behavioural contract.
edges:
  - target: context/architecture.md
    condition: when working on system design, integrations, or understanding how components connect
  - target: context/stack.md
    condition: when working with specific technologies, libraries, or making tech decisions
  - target: context/conventions.md
    condition: when writing new code, reviewing code, or unsure about project patterns
  - target: context/decisions.md
    condition: when making architectural choices or understanding why something is built a certain way
  - target: context/setup.md
    condition: when setting up the dev environment or running the project for the first time
  - target: context/ai.md
    condition: when working on AI tagging, Smart Categorization, or the CLIP encoder
  - target: patterns/INDEX.md
    condition: when starting a task — check the pattern index for a matching pattern file
last_updated: 2026-07-11 (UX-optimization pass)
---

# Session Bootstrap

If you haven't already read `AGENTS.md`, read it now — it contains the project identity, non-negotiables, and commands.

Then read this file fully before doing anything else in this session.

## Current Project State

**Working:**
- Five-step wizard: Configure → Analyse → Preview → Sort → Report
- Update checker fully wired: `UpdateService` + `GET /api/update` → `useUpdateCheck` → in-app `UpdateBanner`
- EXIF / video metadata / filename / mtime date extraction (priority order)
- SHA-256 exact + perceptual hash duplicate detection (per-run)
- Local AI tagging (offline, multi-label sigmoid scoring) — CLIP ViT-B/32 (Lite) or SigLIP 2 (Standard/Max)
- SigLIP 2 ONNX encoder (`siglip_encoder.py`): onnxruntime + Gemma tokenizer, lazy HF download, CoreML/CUDA/DirectML EP, graceful CLIP fallback; tier-gated via `encoder_factory`
- Hardware-tier gating surfaced in the UI: `GET /hardware` → `useHardware` → capability chip + model-tier selector; local-only Smart Categorization auto-disables on too-weak machines
- "Deviates from defaults" UI: `GET /config/defaults` → `frontend/src/lib/configDiff.ts` → per-section dots + per-tab "N settings in this section differ" summary (current ← default) with "Reset section"; `ChangedFromDefaults` component takes optional `resetLabel` prop
- Smart Categorization (anchor-relative softmax, dual confidence + margin gate)
- Rule-based tagging (extension, filename regex, size, resolution)
- Streaming WebSocket live log during sort (`/api/logs/stream`)
- Report export (CSV/JSON) and historical run browser
- HEIC/HEIF image support (pillow-heif)
- macOS arm64 + Intel and Windows x64 release builds via GitHub Actions CI
- Camera subfolder stacking (`…/Y/M/D/<category>/<camera>/`)
- Video keyframe thumbnails: `GET /api/thumbnail?path=video.mp4` extracts a frame at `min(1.0, duration*0.1)` via `extract_frame`/`probe_duration` in `ffmpeg_utils`
- PreviewPanel decomposed: `PreviewList.tsx` (virtual tree, context menu, sort, column resize), `PreviewGrid.tsx` (CSS auto-fill grid with lazy thumbnails, status dot, category badge, video badge), `PreviewPanel.tsx` is now a clean orchestrator with list/grid view toggle
- `CategorySuggestionService`: samples ≤150 images from source dir, embeds, pure-numpy k-means (15 iter), matches centroids to 60-word vocabulary via cosine similarity, returns deduplicated labels; `POST /api/ai/suggest-categories` (body `{n_categories: 2–12}`) → 503 when encoder=None
- "Suggest from photos" UI in FoldersSection: `useAiSuggestions` hook + accept-chips below `CategoryTagsInput`
- Tags and AI category shown as visual chips in `MediaPreviewModal` and `PreviewGrid` (not plain text)
- **Destination-aware / cross-run dedup (opt-in)** — `dedup_against_destination` indexes the destination into `<dest>/.mediasort-dedup-index.sqlite3` (`dedup_index_path` overrides); matches route to `_already_in_destination/`. Match scopes: run/destination (`DuplicateMatch.scope`). *(The deleted-hashes deny-list / `_previously_deleted/` bucket that originally shipped alongside this was removed 2026-07-06 — see "Recently completed" below.)*
- **Junk/thumbnail filter (opt-in)** — `junk_filter_enabled` + size/resolution floors + name patterns → `_junk/`, reason recorded
- **Structure-preserving quarantine** — all quarantine folders keep the source-relative subpath (P0-4 triage)

**Not yet built:**
- Micro-rewards UX feature (idea only — its planning doc was removed with the old analysis folder on 2026-07-02)
- SigLIP scoring constants (tagger_slope=40, categorize_scale=60) are empirically set, not yet swept by a benchmark harness
- P2-1 parallel hashing, full P2-2 mid-run resume — deliberately deferred, not just unstarted (see `../planning/impl/mediasorter-rework.md` P2 status notes: real perf/concurrency work that needs measurement, low value at one-shot-per-directory scale)

**Known issues:**
- fastembed 0.8.0: `jina-clip-v1` text encoder broken; model stuck at ViT-B/32 — do not use `jina-clip-v1` (only affects the CLIP/Lite tier)
- `UpdateService` still checks `github.com/gykonik/media-sorter/releases/latest` (404s → logged as a warning, fails gracefully). Should point at the `fileworks` org; left for the release-plumbing pass, not UX.

**Recently completed (2026-07-11) — UX-optimization pass (branch `feat/ux-pass`, per `../planning/impl/mediasorter-ux-optimization-prompt.md`):**
- **Removed the delete-permanently duplicate action** (`feat(dedup)!`) — duplicates are now always quarantined (`_duplicates/` / `_already_in_destination/`), never deleted, aligning the engine with the app-wide never-delete invariant. `duplicate_action` config field, its UI select, the preview's "will be deleted" section, and all `duplicateAction` prop threading are gone; legacy config files with the key load fine (from_dict drops unknown keys). *(User-approved subjective call.)*
- **Grouped the settings rail** into Setup / Cleanup / Extras (`SECTION_META.group`, desktop-only headers in `SettingsRail`); Scan & filters moved up beside Duplicate detection. *(User-approved.)*
- **Surfaced `junk` + `already_in_destination`** everywhere they were falling through to the generic error icon / raw status string: status icon/color/tooltip maps in `PreviewList`/`PreviewGrid`/`MediaPreviewModal`, report filter tabs + `STATUS_STYLES`, and the report **summary** (they were persisted to the operations table but dropped by `report_service._get_report_sync`). Report/celebration cards now fold junk→Quarantined, already_in_destination→Duplicates.
- **Token cleanup** — replaced hardcoded Tailwind palette colors with semantic tokens; added a theme-aware `category` token (`--color-category`) for Smart-Categorization chips. Toasts restyled to card+accent-edge (the solid raw-color bgs failed dark-mode contrast). `ReportPanel`'s categorical type-chart palette + `LogViewer`'s terminal styling kept by design.
- **a11y batch** — new `useFocusTrap` hook (WCAG modal focus: trap Tab, restore on close) wired into ConfirmDialog / MediaPreviewModal / DuplicateComparison / history ReportModal; `inert` on locked config inputs; `aria-expanded` on preview tree rows; `aria-pressed` on preview status filters; `aria-sort` + real `<button>` on report table headers; labelled the 3 search inputs + RuleBuilder fields.
- **Perf** — `PreviewGrid` is now row-windowed (measures its own scroll container; a 300-file library mounts ~42–56 cards, verified via Playwright, vs. all 300 before); `PreviewList` breadcrumb precomputed once per flatRows (O(1) on-scroll vs O(n)/frame); History page `React.lazy`-split (initial JS 488.5→482.6 kB). Backend `make backend` hint hidden from packaged-desktop users via new `isTauri` helper.
- Verified end-to-end with Playwright (Configure→Analyse→Preview→Sort→Report + History + grid virtualization + config-change guard) on a generated 300-file library; 630 backend + 69 frontend tests, all gates green.

**Recently completed (2026-07-06, later same day) — P0 merge + simplification:**
- **`feat/p0-engine` merged into `main`** (`--no-ff`), after two follow-up commits on the branch first:
  1. **Removed the P1-1 deleted-hashes deny-list** (`deleted_hashes` table in `dedup_index.py`, `DuplicateMatch.checksum`/`scope="deleted"`, `deny_deleted_hashes` config, the `_previously_deleted/` bucket + its UI toggle/help text/stats) — it protected a narrow scenario (hard-delete a dupe → later remove the kept twin from the destination by some other means → rescan a stale source) that doesn't match the user's actual one-shot "sort dir A into dir B" workflow. `_already_in_destination/` (the cross-run dedup that matters) was untouched.
  2. **Closed P1-3** with property-style keeper-selection tests in `test_duplicate_service.py`.
- 613 backend + 71 frontend tests, 86% cov, ruff/ruff-format/mypy --strict/eslint/prettier/tsc/vite-build all green on `main` post-merge.
- Fixed stale `gykonik` org references (`.releaserc.json` `repositoryUrl`, `README.md` CI badge/clone URL) to `fileworks`; added the missing `.github/CODEOWNERS` (the other three repos already had one).
- Added `renovate.json` (auto-merge patch/minor/digest once CI is green; majors stay manual; groups Actions + Rust/Tauri bumps) — same policy landed in all four repos in the workspace.

**Recently completed (2026-07-06) — P0 engine work (branch `feat/p0-engine`, per `../planning/impl/mediasorter-rework.md`):**
- **P0-1** `dedup_index.py` (SQLite, incremental refresh, quarantine dirs excluded) + `check_duplicate(destination_registry=, deleted_hashes=)` with scope labels; sort/preview both wire it; preview refresh skips computing video sigs (no ffmpeg) but uses stored ones. Destination check deliberately beats the deny-list (kept original still in library → `already_in_destination`).
- **P0-2** `junk_filter.py` (name patterns incl. parent dirs, size floor, resolution floor on shorter side) → `_junk/`; off by default (behaviour change = opt-in), reason stored in `error_message` (sort) / `quarantine_reason` (preview item).
- **P0-3** HEIC/RAW audit: fixtures prove HEIC EXIF date + phash; undecodable RAW logs "No perceptual signature" (info) and still places via exact dedup + date chain. Never silently dropped.
- **P0-4** quarantine preserves source-relative subfolders via shared `destination.quarantine_dir` (sort + preview can't drift).
- New statuses `junk`/`already_in_destination`/`previously_deleted` flow through stats, operations DB columns (additive migration), preview stats, frontend buckets/chips/filters; config UI toggles in Duplicates + Filters sections. 615 backend tests + 71 frontend tests green.

**Recently completed (2026-07-02) — full backend sweep + housekeeping (Pass 2 in `REFACTOR_PROGRESS.md`):**
- **Env-override coercion fixed** — `_coerce_env_value` now unwraps PEP 604 unions (`int | None` reports `types.UnionType`, not `typing.Union`, on Python ≤ 3.13); `MEDIASORT_MAX_RECURSION_DEPTH`/`MIN_FILE_SIZE_KB`/`MAX_FILE_SIZE_MB` were stored as strings and crashed the walk with a TypeError.
- **Cooperative task cancellation** — `TaskManager.cancel_task` no longer hard-cancels the asyncio task; the sort/preview loops observe `cancel_event`, break, and (sort) persist the partial operation to the DB; `_run` marks such tasks `cancelled` while keeping the result. Hard cancel remains only in `shutdown()`. Frontend unaffected (it stops polling on cancel).
- **Removed dead surface** — `POST /api/duplicates/scan` + `DuplicateService.find_duplicates` (+ CLI client method, tests, doc rows): zero callers anywhere.
- **Deleted the analysis folder** (6 planning docs) — they completed their purpose; their base file BUGS_AND_IMPROVEMENTS.md was deleted by the user (only the two open ideas above survive, here).
- Legacy CSV tag rows now stripped on read (`serializers._deserialize_tags`).
- **kb docs rewritten to match reality** — `docs/kb-{backend,testing,api-contract,deprecated}.md` had described SQLAlchemy/Alembic/uv/JWT/Angular patterns this repo never had (and forbade the `TestClient` the tests actually use); now they document the raw-sqlite `DatabaseManager`, `ContainerDep`/`ConfigDep`, sync-core+`to_thread`, cooperative-cancel, and snake_case `/api` contract. CLAUDE.md hard rules 2/3/7/8/10 corrected to match.
- Verified green: backend ruff+mypy strict+572 tests (85% cov), frontend lint+68 tests+build, live uvicorn boot smoke test.

**Recently completed (2026-07-01) — startup-crash fix + quality pass:**
- **Fixed the mount crash** — `ConfigPanel.tsx` referenced `sectionFields` inside the `activeSectionFields` `useMemo` before its `const` declaration (temporal dead zone) → "Cannot access 'sectionFields' before initialization" on every load. Hoisted the helper above the hooks.
- **Startup splash** — static theme-aware spinner in `frontend/index.html` (inside `#root`, auto-replaced on React mount) + a pre-paint theme-init script that also removes the old light→dark flash.
- **Extracted `buildFlatRows`** → `frontend/src/lib/previewRows.ts` (with `FlatRow`, `MONTH_NAMES`, `pushDateGroupRows`). Fixes the `react-refresh/only-export-components` warning that was making `eslint --max-warnings 0` (hence CI) red, shrinks the `PreviewList` god-file, and makes the row logic unit-testable (11 new tests → 68 total).
- **Preventive lint** — enabled `@typescript-eslint/no-use-before-define` so the TDZ class of bug fails lint/CI instead of shipping.
- **Docs** — new `docs/settings-reference.md` (every option + real defaults); README default fix (`categorize_confidence_threshold` 0.85→**0.55**) + AI-tier/suggestions notes; CLAUDE.md now documents the frontend/AI architecture. Full record in `REFACTOR_PROGRESS.md` (repo root).

**Recently completed (2026-06-23):**
- **Smart Category Suggestions** — `CategorySuggestionService` (pure-numpy k-means + vocab cosine match); `POST /api/ai/suggest-categories`; `useAiSuggestions` hook; "Suggest from photos" accept-chip UI in FoldersSection. 577 backend tests passing.
- **Video thumbnails** — `GET /api/thumbnail` now handles video extensions via `probe_duration` + `extract_frame` (t = min(1s, 10% of duration)); fallback icon in grid on error.
- **PreviewPanel decomposed** — `PreviewList.tsx` (virtual tree + column resize + context menu), `PreviewGrid.tsx` (CSS auto-fill grid, lazy thumbs, status dot, category + video badges), `PreviewPanel.tsx` is orchestrator with list/grid toggle. Expand/collapse only in list mode.
- **Per-section ChangedFromDefaults** — banner now counts only the active tab's fields and "Reset section" applies only that section; removed misleading global count inside per-tab pane.
- **Visual chips for AI results** — tags and category rendered as styled chips (not plain text) in `MediaPreviewModal` and `PreviewGrid`.

**Earlier (2026-06-22):**
- **Real SigLIP 2 encoder shipped** — `SiglipOnnxEncoder` (validated end-to-end against onnx-community weights, correct image↔caption ranking on CoreML); `encoder_factory` standard/max → SigLIP with CLIP fallback; the old "not yet bundled" log is gone. `make bundle-siglip` + `scripts/fetch_siglip_model.py` for offline release builds. Backend CI green (567 tests).
- **`set_config` encoder invalidation** — changing `ai_model_tier`/`ai_allow_gpu` now drops the cached encoder + dependent services so a tier switch actually takes effect (rebuilt lazily off the event loop).
- **Frontend**: stepper highlights the furthest reached step (incl. in-progress pulse); help tooltips stay clickable + readable while options are locked (portal + `pointer-events-auto`); accurate "deviates from defaults" via `GET /config/defaults`; hardware capability chip + model-tier selector. Frontend green (57 tests).

**Earlier (2026-06-21):**
- BUGS_AND_IMPROVEMENTS full-project review — **all items implemented** (the file itself was deleted 2026-07-02)
- API layer modernised: typed `Depends` (`ContainerDep`/`ConfigDep`) on every route, `ServiceContainer.set_config()`, `POST /config` 422 validation, `UnsupportedMediaError` (415), shared `TaskProgressResponse` + response models for stable shapes, `/sorting/{id}/report` 404/409 contract
- Integration tests under `backend/tests/test_api/` alongside `backend/tests/test_services/` unit tests

## Routing Table

Load the relevant file based on the current task. Always load `context/architecture.md` first if not already in context this session.

| Task type | Load |
|-----------|------|
| Understanding how the system works | `context/architecture.md` |
| Working with a specific technology | `context/stack.md` |
| Writing or reviewing code | `context/conventions.md` |
| Making a design decision | `context/decisions.md` |
| Setting up or running the project | `context/setup.md` |
| AI tagging, categorization, or CLIP encoder | `context/ai.md` |
| Any specific task | Check `patterns/INDEX.md` for a matching pattern |

## Behavioural Contract

For every task, follow this loop:

1. **CONTEXT** — Load the relevant context file(s) from the routing table above. Check `patterns/INDEX.md` for a matching pattern. If one exists, follow it. Narrate what you load: "Loading architecture context..."
2. **BUILD** — Do the work. If a pattern exists, follow its Steps. If you are about to deviate from an established pattern, say so before writing any code — state the deviation and why.
3. **VERIFY** — Load `context/conventions.md` and run the Verify Checklist item by item. State each item and whether the output passes. Do not summarise — enumerate explicitly.
4. **DEBUG** — If verification fails or something breaks, check `patterns/INDEX.md` for a debug pattern. Follow it. Fix the issue and re-run VERIFY.
5. **GROW** — After meaningful work, run this binary checklist:
   - **Ground:** What changed in reality? Name the changed behavior, system, command, dependency, or workflow.
   - **Record:** If project state changed, update the "Current Project State" section above. If documented facts changed, update the relevant `context/` file surgically.
   - **Orient:** If this task can recur and no pattern exists, create one in `patterns/` using `patterns/README.md`, then add it to `patterns/INDEX.md`. If a pattern exists but you learned a gotcha, update it.
   - **Write:** Bump `last_updated` in every scaffold file you changed. If the why matters, run `mex log --type decision "<what changed and why>"` or `mex log "<note>"`.
