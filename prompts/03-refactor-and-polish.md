# Prompt 3 — Refactor and polish: correctness, consistency, motion, cost

Run this on a tree whose gates already pass. Paste everything below the line
into a fresh session opened at `/Users/buechel/Documents/dev/fileworks/media-sorter`.

---

You are refactoring **MediaSorter**, an offline desktop app: a Tauri (Rust)
shell launches a FastAPI/Python backend on a free port and points a React +
TypeScript (Vite) frontend at it over HTTP + WebSocket. Read `CLAUDE.md` at the
repo root first, then the workspace `../CLAUDE.md` and `../REVIEW-GUIDE.md` —
their rules override your defaults. `../openspec/specs/` is the behavioural
source of truth; start at its capability index, do not read the whole set, and
update any spec whose behaviour you change.

Do the work below. Do not ask permission to start; ask only where two readings
would produce materially different work.

## What this pass is, and is not

This is a **refactor and polish** pass over code that already works. It is not a
rewrite, and it is not a feature. The bar is:

> Every screen and every module reads as though one person built it on one
> afternoon, with one set of rules, and left evidence for each rule.

MediaSorter moves and deletes people's photographs. No refactor may weaken a
safety invariant to make code prettier. If a cleanup and a guarantee conflict,
the guarantee wins and you say so in the report.

## Ground rules

- **A finding you cannot demonstrate is not a finding.** Reproduce it, fix it,
  and leave a test that fails without the fix. "This looks fragile" is not a
  defect; "this drops the last row when the list is exactly one page" is.
- **Prefer enforcement over prose.** This repo's convention is that a rule which
  lives only in a comment drifts. `src/lib/__tests__/interactionContracts.test.ts`
  is the pattern: it asserts rules against the source tree — confirmation
  policy, one dialog mechanism, native `title`, button variants, the radius
  scale. When you settle a new rule, add it there rather than writing it down.
- **Never couple a test to styling.** If a test finds an element by a padding or
  colour class, give the element a stable `data-*` hook and point the test at
  it. Precedent: `data-setting-row`, `data-set-row`, `data-stage-id`.
- **i18n is enforced.** `src/i18n/messages.ts` carries every key in both `en`
  and `de`, with no orphans and no duplicates; `src/i18n/__tests__/messages.test.ts`
  checks key usage against the whole tree. Any string you add or rename must
  keep that parity.
- **Measure before you condense or optimise.** For layout, write a throwaway
  Playwright probe that reports real rendered geometry, change one thing,
  re-measure, delete the probe. For performance, profile — do not assume.
- **Do not restyle what works** to make a diff look thorough. Leave the detail
  and compare dialogs alone unless you find an actual defect in them.

## 1. Correctness first

Hunt real bugs before touching anything cosmetic. Weight your search by blast
radius: anything that decides which file is kept, where a file lands, or whether
a file is deleted outranks everything on this page.

Places worth reading with suspicion:

- **Ordering.** There is one screen-wide sort (`src/lib/reviewSort.ts`) and
  several surfaces that render the same rows. A surface that takes the
  catalogue's own order instead of the sorted one produces labels that disagree
  with what the reader clicked. That class of bug has already appeared once
  between the compare dialog and the copy list; look for the rest of it.
- **Off-by-one and empty-set handling** in virtualised lists, pair walking, and
  index-to-id mapping.
- **State that survives when it should not** — a decision, a selection, or a
  cached plan carried across a change that should have invalidated it.
- **Async ordering**: a stale response overwriting a newer one, an effect that
  fires on a value it also sets, a WebSocket message applied after teardown.
- **Backend blocking I/O on the event loop.** Every file and ffmpeg call goes
  through `asyncio.to_thread`; `docs/kb-deprecated.md` lists the known traps.

### Two known leads, both real, neither yours to inherit blindly

1. **`backend/tests/test_catalog.py::TestSchema::test_catalog_can_rebuild_after_migration_from_the_backup`
   fails on macOS and no CI job runs it there.** It fails at pristine `HEAD` on
   macOS 26, reproduced in a clean worktree with a cleared pytest temp root. CI
   is green because the full suite runs on `ubuntu-latest`, and the
   `macos-latest` backend job runs only `test_verified_transfer`,
   `test_transfer_end_to_end`, `test_path_identity` and `test_root_identity`.
   This is catalog durability code — the failure mode is
   `CatalogCorruptionError: Catalog changed while its schema was inspected`.
   Decide whether the test or the code is wrong, fix the right one, and close
   the coverage gap so CI can see it.
2. **The desktop icon geometry is settled — do not "fix" it back.** macOS 26
   normalises every legacy `.icns` onto the standard squircle plate, rescaling
   the artwork's opaque bounds to 824/1024 whatever they were authored at
   (verified with `NSWorkspace.icon(forFile:)` on 26.6: this app, Mail, Notes,
   Terminal and VS Code all render at exactly 412px of 512). The tile therefore
   sits on Apple's 824/1024 grid and the mark's `scale(1.45)` is the only number
   visible on macOS. `scripts/generate_branding.py` asserts all of it.

## 2. Consistency in the code

- **One way to do each thing.** Find the places where two mechanisms coexist for
  one job — two ways to build a dialog, two ways to fetch, two shapes of error
  handling, two spellings of the same class. Pick the one the design system or
  `CLAUDE.md` names, migrate the other, and add the assertion that stops it
  coming back.
- **Use the shared primitives.** `src/components/ui/` owns `Button`, `Select`,
  `Input`, `Toggle`, `Modal`, `Tooltip`, `SettingRow`, `StateView`, `Badge`,
  `Progress`. Roughly twenty raw `<button>` elements in the tree paint their own
  chrome. Some are legitimate (the modal's own close control, a thumbnail
  overlay); several are a shared variant re-typed by hand. Judge each, migrate
  the ones that are just `Button` in disguise, and leave a comment on the ones
  that are genuinely different.
- **Naming.** Same concept, same word, everywhere — in props, state, message
  keys, CSS classes and test names. A `set` in one file and a `group` in the
  next for the same thing is a bug in the reader's head.
- **Delete rather than deprecate.** Dead exports, unused props, commented-out
  branches, options nothing sets. `module-growth-policy.json` exists because
  files here grow; check it.
- **Types.** No `any` in TypeScript, no `Any` in Pydantic, `response_model` on
  every FastAPI route, exhaustive switches. Do not annotate what is inferred.

## 3. Consistency in the interface

`docs/design-system.md` is the contract. Read it before you change a pixel.

- **Radii resolve to exactly three values and the scale is closed.** 6px
  `rounded-control`, 10px `rounded-panel`, 14px `rounded-window`. Write the
  semantic name, never `sm`/`md`/`lg`/`xl`/`2xl`, and never a bare `rounded`.
  Both halves are asserted; do not reintroduce a fourth value.
- **Two control heights and no others**: 32px for toolbars, 36px for forms.
  Coarse pointers raise `.ui-button` to 44px.
- **Spacing is a 4px grid** — 4 / 8 / 12 / 16 / 20 / 24. Half-steps (`px-2.5`,
  `py-1.5`, `py-3.5`) survive in the surfaces nobody has touched recently.
  Sweep them onto the scale. The 2px sub-step is reserved for optical insets
  inside a chip and baseline nudges between two lines of text.
- **One idiom per job.** A marked item in a list or rail is a 3px `primary`
  pill, centred and shorter than the row — never an inset box-shadow, which
  follows the row's radius and tapers into a crescent. The left border in
  `DestinationTree` is deliberately different: contiguous across rows, it draws
  a spine down a subtree rather than marking one row. Look for other places
  where one visual job has grown two treatments, and for places where two
  different jobs have collapsed onto one.
- **Check every screen at 360px and at 200% zoom.** The Playwright suite tests
  both, but only on the screens it visits.

## 4. Colour

`src/index.css` holds the tokens; `docs/design-system.md` holds their meanings.

- **One hue, one meaning.** `suggest` is advice the reader has not taken;
  `success` is a settled fact; `error`/`destructive` is failure or a destructive
  action and never forks; `warning` and `info` are unchanged. Verify the sweep
  actually held — find any element still wearing the wrong one.
- **No raw colour literals** outside the dependency-free startup and crash
  surfaces and generated artwork. A new semantic role starts as a CSS variable
  in **both** themes, is exposed in Tailwind, and only then consumed.
- **Never `opacity` to convey state on anything carrying text.** It drags
  contrast-tuned copy below AA exactly where somebody is reading it. Disabled
  controls change fill, edge and ink instead.
- **Contrast must pass in both themes.** Only the Playwright suite can judge
  this — jsdom composites no colour.

## 5. Motion

The design system specifies motion and almost nothing enforces it, so this is
where drift is most likely. Audit every animated surface against it:

- Colour and opacity transitions ~150ms; screen entry a 3px upward fade over
  160ms; toggle and media fades 200ms; progress changes 300–500ms.
- Buttons get a restrained pressed state. **Movement must never encode status by
  itself** — if a thing is loading, say so in text as well.
- `prefers-reduced-motion: reduce` must remove animations, transitions and
  smooth scrolling. Verify it genuinely does, on every surface, including ones
  added since the rule was written. Emulate it in Playwright rather than
  trusting the media query is present.

Then make the motion *good*, not merely compliant: transitions should explain a
change (where a panel came from, what just got decided), never decorate it.
Anything that animates on every keystroke or every poll tick is noise — find and
remove it. Prefer transitions on `transform` and `opacity`; animating layout
properties on a virtualised list is a performance bug wearing a design costume.

If you settle motion rules, add them to the contract test. A number that lives
only in `design-system.md` is a number that will drift.

## 6. Cost

Optimise what you can measure, and only that.

- **Frontend**: unnecessary re-renders on the review surfaces (they carry
  thousands of rows), work done in render that belongs in a memo, effects with
  over-broad dependency arrays, and anything that defeats the virtualised
  windows. Check the built bundle for a dependency pulled in whole for one
  helper.
- **Backend**: N+1 patterns against SQLite, queries that could be one statement,
  work repeated per file that could be hoisted per run, and any blocking call
  that escaped `asyncio.to_thread`.
- **Thumbnails and media** are the hot path — `scripts/benchmark_thumbnail_delivery.py`
  and `scripts/benchmark_content_identity.py` exist. Use them and report before
  and after numbers rather than adjectives.

Do not trade clarity for a speedup you cannot measure.

## 7. Accessibility

WCAG 2.1 AA is the floor, not the goal. Keyboard reachability, visible focus,
target size, names and roles, and live-region announcements for anything that
changes without a click. The a11y suite covers the screens it visits — extend
it to the ones it does not.

## Do not

- Weaken or route around a safety invariant, a fail-closed guard, or a
  verification step.
- Reintroduce a fourth radius, a third control height, or a second dialog
  mechanism.
- Add AI or agent attribution to commit messages or PR bodies. No
  `Co-Authored-By`, no agent name, no session link. Conventional Commits only.
- Merge to `main`. `feat:` and `fix:` on `main` cut a public release; open a PR
  and stop there.
- Commit `prompts/`, `planning/`, `openspec/` or `.mex/`.

## Definition of done

Every one of these, and note that **`npm run lint` is not the whole frontend
gate** — Prettier is a separate CI job and fails the build on its own:

```bash
# frontend/
npx tsc --noEmit
npm run lint                # eslint --max-warnings 0
npm run format:check        # prettier — a separate CI gate from lint
npx vitest run
npx playwright test         # contrast, target size, focus, reflow — jsdom cannot
npm run build

# repo root
make ci                     # branding-check + contracts-check + ruff + mypy + pytest (cov >= 80)
```

`make ci` covers the **backend only**; the frontend commands above are not part
of it and must be run explicitly. Then confirm the real app still starts with
`make dev` from the repo root — Vite must come up and Tauri must get past
`Waiting for your frontend dev server`.

## What to hand back

1. **Defects found and fixed** — each with its reproduction, the fix, and the
   test that now holds it.
2. **Consistency changes** — grouped by rule, with the assertion you added so
   each rule stays settled.
3. **Measurements** — before and after, for anything you claim is faster,
   smaller or more compact.
4. **What you deliberately left alone**, and why. A working thing you chose not
   to touch is a result, not an omission.
5. **What you could not verify**, and what it would take. Be explicit.

Do not report a gate as passing that you did not run. Treat a skipped or
unexecuted check as unverified, never as passing. If you could not finish
something, say which part and why, rather than narrowing the scope silently.
