# Prompt 2 — Production-readiness review

Run this **after** `01-implement-open-work.md` is finished and its gates pass.
Paste everything below the line into a fresh Claude Code session opened at
`/Users/buechel/Documents/dev/fileworks/media-sorter`.

---

You are reviewing **MediaSorter** for release. Read `CLAUDE.md` at the repo
root, the workspace `../CLAUDE.md`, and `../REVIEW-GUIDE.md` — that guide is the
standard this repository is judged against. `../openspec/specs/` is the
behavioural source of truth.

This is a **review**, not a rewrite. Find what is actually broken, prove it, fix
it, and prove the fix. Do not restyle things that work. A finding you cannot
demonstrate is not a finding — say so and move on.

## What "production ready" means here

MediaSorter moves and deletes people's photographs. The bar is not "the tests
pass"; it is **no run can lose a file, and no screen can lie about what a run
will do.** Weight your effort accordingly.

## 1. Prove the safety invariants, do not assume them

Work through `../REVIEW-GUIDE.md`'s safety invariants and, for each one, find the
test that actually holds it. Where a test is missing, or asserts something
weaker than the invariant claims, write the real one.

Pay particular attention to:

- **Verified transfer.** A move must not remove the source until the destination
  copy has been verified. Check the failure paths, not the happy one: a disk
  filling mid-run, a destination that disappears, a cancellation between commit
  and journal.
- **Plan / execution agreement.** The preview promises a destination path;
  execution must write exactly that path. `predicted_filename`,
  `_plan_dest`, `companion_destination` and the reviewed-plan rewriters in
  `backend/app/core/sort_plan.py` must not be able to disagree. A recent change
  made renaming lower-case the extension — confirm the preview and the run agree
  on it in every combination of rename × conversion × collision × companion.
- **Companion media units.** Members of one unit must land together or not at
  all. Confirm the opt-out is the only way to split one.
- **Review decisions bind the run.** A keeper chosen in Review must be the file
  the run keeps, including after a reload and a plan recovery.
- **Fail-closed.** Where authorisation, integrity or capability checks refuse,
  confirm the refusal stops the run rather than being logged and stepped over.

## 2. Hunt for real bugs

Go looking, with the app running (`make dev`), not only in the source:

- Walk the whole flow end to end on a **real** folder of mixed media — HEIC,
  RAW+JPEG pairs, live photos, video, a corrupt file, an unreadable one,
  duplicates that are byte-identical and duplicates that are merely similar.
- Do it again and **interrupt** it: cancel a scan, cancel a preview, reload the
  window mid-run, kill the backend and bring it back.
- Do it again in **German**, in **dark mode**, at **360px**, and at **200%
  zoom**.
- Try the paths people actually hit that tests rarely do: an empty source, a
  source inside the destination, a read-only destination, a drive that
  disappears mid-run, two roots that overlap, 50k files.

For every defect: write the failing test first, then fix it.

## 3. State machine and navigation

The stage flow (`frontend/src/lib/stageModel.ts`) is where "which screen may I
be on, and may I leave it" is answered. Confirm there is no way to reach a
screen whose preconditions are gone, and no way for the app to move the user
somewhere they did not ask to go. Recent fixes in this area were:
`reconcile` keeping Review while its own plan is recomputed, and the review stop
surviving a recalculation — check they hold under every entry point, including
recovery after a restart.

## 4. Accessibility, at the level the suite cannot reach

`frontend/e2e/a11y.spec.ts` covers contrast, target size, focus obscuring and
reflow on the screens it visits. Extend it to the screens it does not, then go
beyond it:

- Complete every task with the **keyboard only**, including the duplicate
  decisions and every dialog.
- Check the focus order is the reading order on each screen, that focus is
  restored correctly when each dialog closes, and that nothing traps focus
  outside a dialog.
- Confirm live regions announce **what changed** and not the whole toolbar.

## 5. Errors, empties and honesty

- Every failure path must surface a message a person can act on — never a raw
  stack trace, never a bare code. `frontend/src/lib/errorUtils.ts` and the
  backend's `{"error","code","details"}` envelope are the contract.
- Every list has an on-brand empty state that says what to do next.
- Every long operation reports real progress or says honestly that it cannot.
- Nothing claims a file is safe, verified, or done unless it is.

## 6. Release mechanics

- `uv --directory backend run python ../scripts/generate_branding.py --check`
- `node scripts/releaseability.cjs` and `scripts/release_integrity.py` — read
  what they check and confirm they still check it.
- Confirm the packaged app icon carries macOS safe-area padding (the artwork
  should occupy 824 of 1024 pixels, centred — `magick branding/app-icon.png
  -trim info:` proves it).
- `CHANGELOG.md` reflects what actually changed.
- Conventional Commits, no AI/LLM attribution in messages, and remember that
  `feat:`/`fix:` on `main` cut a public release while `chore:`/`docs:` do not.

## 7. Dependencies and supply chain

Check for known-vulnerable dependencies on both sides, confirm
`dependency-audit-suppressions.json` entries are still justified, and confirm no
secret, token, private path or personal media has been committed anywhere in the
history you are adding to.

## Gates

```
# frontend/
npx tsc --noEmit -p tsconfig.json
npm run lint
npx prettier --check "src/**/*.{ts,tsx}" "e2e/**/*.ts"
npx vitest run
npx playwright test
npm run build

# repo root
uv --directory backend run pytest -q
uv --directory backend run ruff check app tests
uv --directory backend run ruff format --check app tests
uv --directory backend run mypy app
uv --directory backend run python ../scripts/generate_branding.py --check
make dev            # confirm the real app starts and the window comes up
```

## What to hand back

A single report with:

1. **Ship / do not ship**, and the reason in one sentence.
2. **Blocking defects** — what breaks, the exact reproduction, the fix, and the
   test that now holds it.
3. **Non-blocking findings** — ranked, each with the cost of leaving it.
4. **What you could not verify**, and what it would take to verify it. Be
   explicit here; an unverified claim in a release review is worse than an
   admitted gap.

Do not report a gate as passing that you did not run. Treat a skipped check as
unverified, never as passing.
