# Prompt 1 — Finish the open work: duplicate handling, consistency, clarity

Paste everything below the line into a fresh Claude Code session opened at
`/Users/buechel/Documents/dev/fileworks/media-sorter`.

---

You are working on **MediaSorter**, an offline desktop app: a Tauri (Rust) shell
launches a FastAPI/Python backend on a free port and points a React + TypeScript
(Vite) frontend at it. Read `CLAUDE.md` at the repo root first, and the
workspace `../CLAUDE.md` and `../REVIEW-GUIDE.md` — their rules override your
defaults. `../openspec/specs/` is the behavioural source of truth; start at its
capability index, do not read the whole set, and update the specs you change.

Do the work below. Do not ask for permission to start; ask only where two
readings would produce materially different work.

## Ground rules for this task

- **Every change must be verifiable.** The gates are listed at the bottom. They
  must all pass when you are done, including the Playwright suite — it is the
  only thing in this repo that can judge contrast, tap-target size, focus
  obscuring and reflow, because jsdom has no layout.
- **Measure before you condense.** When a screen "feels spacious", write a
  throwaway Playwright probe that reports real rendered heights, change one
  thing, re-measure, and delete the probe. Do not guess at padding.
- **Do not couple tests to styling.** If a test finds an element by a padding or
  colour class, give the element a stable hook (`data-*`) and point the test at
  that instead. There is precedent: `data-setting-row`.
- **i18n is enforced.** `src/i18n/messages.ts` must carry every key in **both**
  English and German, and must carry **no key the interface never reads** —
  `src/i18n/__tests__/messages.test.ts` fails on either. Delete superseded keys
  rather than leaving them.
- **Module growth is enforced.** `module-growth-policy.json` caps several files
  (`frontend/src/pages/MainPage.tsx` at 1050 lines among them) and
  `backend/tests/test_module_growth.py` fails when one crosses its point. If you
  push a file over, extract the part that is not that module's job — do not just
  raise the number.

## 1. Duplicate handling — the main piece of work

### The intent, in the operator's words

> The most important way is to just use the tree view, and then just sort. But
> sometimes I manually want to select which images or videos are duplicates, and
> if so it should be easy. I'm fine with the list view of all duplicate sets on
> the left, but the right side and the bulk-action things need improvement
> structurally, UI and UX wise. And it should be easy to compare images.

So there are two paths, and the first one has to be complete on its own.

### 1a. The tree view must be sufficient on its own

Review has two tabs: **Browse the result** (a destination tree with a file pane)
and **Decide the duplicates** (a queue). Browse is now the landing tab.

A user who does not care about duplicate details must be able to finish an
entire run without ever opening the Decide tab. Today they cannot: every
duplicate set must become an explicit decision before Execute unlocks, and the
only bulk way to do that lives on the Decide tab.

Add an **"accept every recommendation"** affordance to the Browse surface —
one action that takes the keep rule's proposal for every set still open, with
the same guarantees the existing `acceptAllProposals` has (it must never
overwrite a decision the user made themselves, and never touch a set whose
keeper is fixed by a reference root). State plainly how many sets it will
decide, and make the result visible in the tree.

Read `frontend/src/hooks/useReviewSurface.ts` first —
`keeperRecommendations` / `keeperProposals` already draw exactly the line you
need between "what the rule ranks first" and "what is still an open offer".

### 1b. Rework the right-hand side of the Decide tab

Keep the left list of duplicate sets. It works.

The right side is currently: a sticky set header, a recommendation panel, the
copy rows, and a pinned decision bar. Restructure it so that **manually choosing
which copies are duplicates is the easy, obvious thing to do**:

- Selecting a keeper, marking a set as "not duplicates", and comparing two
  copies should each be reachable in one gesture from the copies themselves.
- Comparing should be immediate — the operator explicitly asked for "easy to
  compare images". Consider making comparison reachable directly from a pair of
  copy rows rather than only from the header.
- The copy rows carry a thumbnail, a name, a folder, a size, a date and a
  planned destination. Decide what a person actually chooses on and let that
  dominate; demote the rest.

### 1c. Rework the bulk actions

The bulk actions (apply keep rule / mark not duplicates / keep from folder) now
live in the toolbar strip, which swaps between a default state and a selection
state at one fixed height. That solved the floating-bar problem. It did **not**
make the actions themselves good: three buttons with counts and a folder picker
crammed into one row is still cramped, and "Keep from folder" is unexplained
until you use it.

Rework them structurally. Requirements that must survive:
- The strip must not change height between its two states — a checkbox tick must
  never move the list the checkbox is in. `e2e/duplicates.spec.ts` asserts this.
- Each action must show, visibly and not on hover, how much of the current
  selection it will decide.
- The full impact sentence must remain available to assistive tech.

### 1d. Leave these alone

The **details dialog** and the **compare dialog** are well structured. Do not
restyle them. Fix them only if you find an actual defect.

## 2. Colour: one meaning per hue, and two greens

`frontend/src/index.css` holds the tokens. The ladder was recently collapsed to
one border weight (`/40`), one wash weight (`/10`), and a single red
(`--destructive` now references `--color-error`). Keep that discipline.

What is still wrong: **a recommendation and a success wear the same green.** The
operator wants them distinguishable:

- **Recommendation / suggestion** — one hue, used by the recommendation panel,
  the "Recommended" badge, the dashed outline on a recommended copy, the
  "suggested" tag in Browse, and the `success` button variant that accepts a
  proposal. This is *advice the user has not taken yet*.
- **Success / confirmed / done** — a different green: a decided set, a kept
  copy, a completed run, a passing safety check. This is *a settled fact*.
- **Error** — red, `--color-error`, everywhere. `--destructive` is the filled
  action pairing of the same hue and must stay in step.
- **Warning**, **info** — unchanged.

Introduce the new token properly (light and dark, plus its tint), sweep every
current usage onto the right one of the two, and make sure the Playwright
contrast check passes in **both** themes.

## 3. Disabled, locked and busy must look it

The operator's complaint: *"when 'These settings are being read, not edited' is
active, it is not quite clear because all buttons and stuff still look active."*

That is now routed through real `disabled` attributes plus a desaturation filter
on Configure's settings column, with the rail left navigable
(`stageDrawsOwnLock` in `frontend/src/lib/stageModel.ts`). Finish the job:

- Audit **every** surface that can be read-only, busy, or blocked — Sources,
  Recipe, Configure, Review, Execute, and every dialog — and make the state
  legible without reading a banner.
- A disabled control must never merely look "slightly faded". Use the design
  system's disabled styling, and never `opacity` on text: it takes AA-tuned
  copy below AA at the moment someone is trying to read it.
- Where something is unavailable, say **why**, once, near the thing — not in a
  banner at the top of an unrelated screen.

## 4. Consistency sweep

Padding and spacing are on a 4px grid in the surfaces that were recently
touched; much of the rest still uses half-steps (`px-2.5`, `py-1.5`, `py-3.5`).
Bring the repeated surfaces onto one scale. Radii already resolve to exactly
three values — control 6px, panel 10px, window 14px — keep it that way and do
not introduce a fourth.

Check every screen at **360px** and at **200% zoom**; the Playwright suite tests
both, but only on the screens it visits.

## Definition of done

All of these, from `frontend/` unless stated:

```
npx tsc --noEmit -p tsconfig.json
npm run lint                       # eslint --max-warnings 0
npx prettier --check "src/**/*.{ts,tsx}" "e2e/**/*.ts"
npx vitest run                     # 911 passing at the time of writing
npx playwright test                # 20 passing; contrast, targets, focus, reflow
npm run build

# from the repo root
uv --directory backend run pytest -q                     # 2261 passing
uv --directory backend run python ../scripts/generate_branding.py --check
```

Then confirm the real app still starts: `make dev` from the repo root, and check
that Vite comes up and Tauri gets past `Waiting for your frontend dev server`.

Report honestly. If you could not finish something, say which part and why,
rather than narrowing the scope silently.
