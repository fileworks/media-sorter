# MediaSorter design system

This is the implementation contract for the React interface. The final Open Design
artifact `mediasorter-final.html` in project
`eb5798f0-0ef4-4a7b-a645-5d5225dd9d80` is the visual reference; this document explains
where that contract lives in production code.

## Sources of truth

| Concern | Canonical implementation |
|---|---|
| Semantic color values and global control primitives | `frontend/src/index.css` |
| Tailwind names for colors, type, radii, shell geometry, workspace, and elevation | `frontend/tailwind.config.js` |
| Shared controls | `frontend/src/components/ui/` |
| Fixed shell and six-step navigation | `frontend/src/components/shell/` and `StageShell.tsx` |
| Product and repository identity | `branding/app-icon.svg`, `frontend/public/icon.svg`, and `.github/icon.svg` |
| Generated platform artwork | `scripts/generate_branding.py` |

Components must use semantic Tailwind names. Raw color literals belong only in the
dependency-free startup/crash surfaces or generated artwork. A new semantic role starts
as a CSS variable in both themes, is exposed in Tailwind, and is then consumed by a
component; do not introduce a one-off color at the use site.

## Semantic color language

| Role | Tokens | Meaning |
|---|---|---|
| Canvas and surfaces | `background`, `card`, `popover`, `surface-muted`, `muted` | page, cards, floating and quiet regions |
| Text | `foreground`, `muted-foreground`, `faint` | primary, explanatory, and metadata text |
| Action | `primary`, `primary-hover`, `brand`, `tint-primary` | primary actions, selection, changed values, pending work |
| Suggestion | `suggest`, `tint-suggest` | what a rule proposes and nobody has taken yet |
| Success | `success`, `decor-success`, `tint-success` | verified, confirmed, complete |
| Warning | `warning`, `decor-warning`, `tint-warning` | caution and meaningful differences |
| Error | `error`, `destructive`, `tint-error` | failure or destructive action only |
| Information | `info`, `tint-info` | neutral information and read-only references |
| Structure | `border`, `input`, `ring` | boundaries, form edges, and keyboard focus |

`brand`, `decor-success`, and `decor-warning` are decorative. Text uses the matching
contrast-tested semantic token. Focus is always a visible two-pixel `ring` treatment.

**One hue, one meaning — and two greens.** `suggest` is advice the reader has not
taken: the recommendation panel, the "Recommended" badge, the dashed edge on a
proposed copy, the "suggested" tag in Browse, and the button that accepts a
proposal. `success` is a settled fact: a decided set, a kept copy, a completed
run, a passing safety check. They wore one colour, so a plan full of untaken
offers looked like a plan full of confirmations. `destructive` is the filled
pairing of `error` and never forks from it.

A disabled control changes its fill, its edge and its ink. `opacity` is never
used to convey state on anything carrying text — it drags contrast-tuned copy
below the floor at the moment somebody is trying to read it. A region that is
readable but not editable carries `.read-only-region`, which drains colour, and is
bounded by a native `fieldset[disabled]` — never `inert`. Both stop every control
inside and remove it from the tab order; only `inert` also makes the text
unselectable, and a read-only screen is one you were sent there to *read*, so its
paths, values and planned destinations have to stay selectable and copyable. The
fieldset disables every native `input`, `select`, `textarea` and `button` beneath it
with no prop threaded through each field, and each picks up its own `:disabled`
styling — which is the part a reader actually recognises as "not enabled". A locked
settings group also carries a padlock chip in its sticky heading, because the one
banner at the top of the screen scrolls away.

## Geometry and typography

- Geist Sans is the UI family; Geist Mono is reserved for paths, filenames, values,
  ordinals, and shortcuts. Both are bundled locally.
- The body is 13px. Screen headings are 22px on a full viewport and remain at least
  20px on compact viewports. Section headings are 14–18px; metadata never drops below
  10px.
- Spacing follows a 4px base: 4 / 8 / 12 / 16 / 20 / 24px, with 8 / 12 / 16 dominant.
  Padding, margins and gaps use whole steps. The 2px sub-step is reserved for the
  optical inset inside a chip and for a baseline nudge between two lines of text;
  it is never spacing between components. Half-steps — 6, 10 and 14px — are not
  part of the scale.
- The app tile is inset within its 1024px canvas at Apple's documented
  **824/1024** macOS grid, and the mark is centred within the tile at
  `scale(1.45)` — about 76% of its width. Which of those two numbers you can
  actually see depends on the platform: macOS 26 normalises every legacy `.icns`
  onto the 824/1024 plate, rescaling the artwork's opaque bounds to reach it
  whatever they were authored at, so on macOS the tile ratio changes nothing and
  only the mark's share of the plate reads as large or small. (Verified with
  `NSWorkspace.icon(forFile:)` on 26.6: this app, Mail, Notes, Terminal and VS
  Code all render their plate at exactly 412px of 512.) Windows and Linux do not
  normalise and are handed the tile ratio verbatim. An earlier revision inset the
  tile to 744/1024 to look smaller in the dock, which that normalisation now
  undoes; all it bought was an upscale on macOS and an undersized icon
  everywhere else. All three numbers (tile ratio, tile centring, mark centring)
  are asserted against the rendered PNG by `scripts/generate_branding.py`,
  because a geometry that lives only inside an approved blob drifts and the icon
  has shipped at the wrong size more than once. `branding/app-icon.svg` is the
  drawing; `branding/app-icon.png` is rendered from it (`rsvg-convert -w 1024 -h
  1024`) and is what `make branding` consumes — changing the drawing means
  re-rendering it and updating `APPROVED_SOURCE_SHA256`. `icons/icon.icns` is
  listed in `tauri.conf.json`'s bundle icons — without it Tauri synthesises its
  own icon set from the PNGs and the verified `.icns` never ships.
- Radii resolve to exactly three values and there is no fourth: 6px for anything you
  press (`rounded-control`), 10px for rows, nested surfaces and media frames
  (`rounded-panel`), 14px for top-level cards, sections and dialogs (`rounded-window`).
  **Write the semantic name, never the Tailwind alias.** `sm`/`md`/`lg`/`xl`/`2xl` still
  resolve to the same three values so third-party markup keeps working, but a component
  that spells ten pixels `rounded-md` in one file and `rounded-lg` in the next says
  nothing about whether the two were meant to match — all three spellings were in use.
  A bare `rounded` was the other leak: `DEFAULT` was unmapped, so it was Tailwind's own
  4px on 29 elements, most of them checkboxes. It now maps onto the control step, and
  `interactionContracts.test.ts` fails on either regression. Cards take a one-pixel
  border and no shadow; shadows are reserved for dialogs, toasts, and primary-action
  emphasis.
- A **marked item** in a list or rail — the current setting in the Configure rail, a
  selected set in the review queue — takes a 3px `primary` pill, vertically centred and
  shorter than the row (`absolute … h-4/5 w-[3px] rounded-full bg-primary`). Not an
  inset box-shadow: a shadow follows the row's own radius, so the rail tapered at both
  ends and read as a crescent beside the row rather than a marker on it. The left border
  in `DestinationTree` is a different thing and stays — contiguous across adjacent rows,
  it draws a spine down a subtree rather than marking one row.
- The workspace is capped at 1480px (`max-w-workspace`). The shell rails are 48px for
  the title bar, 62px on wide desktop / 56px on tablet for the stepper, and at least
  60px for the action bar.
- Controls come in two heights and no others: **32px** for a toolbar (`Button` `sm`,
  `Select` `sm`, `Segmented` `compact`, the search field) and **36px** for a form
  (`Button` default, `Select` `md`, `Input`, `Segmented` default). There used to be
  four — 32, 36, 38 and 40 — so a select standing beside a button in the same row was
  6px taller than it for no reason anybody could name. Coarse pointers raise `.ui-button`
  to 44px.

## Workflow and component rules

The visible flow is Sources → Recipe → Configure → Plan → Review → Execute. Every screen
has one `ScreenHeader`, one persistent primary action at the bottom right, and a quiet
safety or estimate sentence in the footer. Plan is a read-only impact checkpoint. Review
has destination-browse and duplicate-decision modes. A recommendation is `suggest`
and dashed; a settled keeper is `success` and solid. Either mode can decide a set,
in bulk as well as one at a time, so a run can be finished without opening the
decision queue at all.

Use the shared `Button`, `Select`, `Input`, `Toggle`, `Modal`, `Tooltip`, `SettingRow`,
and `StateView` before adding local control chrome. A component owns its layout; global
CSS owns tokens, native control normalization, motion accessibility, and the two review
row grids below.

### Review row grids

Browse is a table in everything but markup, so its column template lives once in
`index.css` as `.asset-grid` rather than inline on each row. The header row shares the
class with its rows, which is what stops a heading from naming a column the rows do not
have.

| Class | Columns | Drops at 1280px | Drops again at 900px |
|---|---|---|---|
| `.asset-grid` | select · thumbnail · name · date · status · destination | destination | status |

Columns drop from the right, least-decisive first — a destination is recoverable from
the row's detail view, a file's name is not.

Resolve had a second grid of the same shape, with columns for size, date, date source and
destination. It is gone. Members of an exact set are byte-identical, so four of those
columns printed the same value once per row while the two facts that *can* differ — the
source folder and the recorded date — were given no more weight than the four that
cannot. A duplicate set is a list of copies, not a table of facts: a copy row leads with
the folder, follows with date · size · destination in one quiet line, and puts keep and
compare on the copy they act on.

Rows quote destinations relative to the library root and folders by their leaf name
(`relativeDestination`, `folderLeaf` in `lib/reviewRows.ts`). Absolute paths repeat one
machine-specific prefix down the whole column and truncate away the part that differs;
the full value stays on the element's `title`.

A virtualized list keeps its column header inside the scroll container as a sticky row.
A header outside one is offset by the scrollbar and drifts out of line with its columns.

## Motion

- Color and opacity transitions: about 150ms.
- Screen entry: 3px upward fade over 160ms.
- Toggle and media fades: 200ms.
- Progress changes: 300–500ms.
- Buttons have a restrained pressed state; movement must never encode status by itself.
- `prefers-reduced-motion: reduce` removes animations, transitions, and smooth scrolling.

## Responsive contract

- Minimum supported width: 320px.
- Below 768px only the active workflow step is shown; the footer gives Back and the
  primary action equal space.
- Two-column recipe, plan, configure, review, compare, and approval layouts collapse to
  one column before their content becomes cramped.
- Long paths truncate with an accessible title. Long option labels wrap; comparison
  tables scroll inside their own bounded region. No inner pane may widen the app shell.
- Acceptance checks cover 1440px desktop, 960px tablet, 390px phone, and the 320px
  minimum. They check the document and every scroll container for unintended horizontal
  overflow.

## Identity contract

The Kontur family is the only current repository identity. Every repository keeps the
approved SVG at `.github/icon.svg`, references it from the README at 72×72, and stores a
self-contained 1280×640 `.github/social-preview.svg` plus rendered PNG. Public preview
copy states the product benefit and useful operating facts; internal direction names and
artwork versions are excluded. The shared template and semantic copy live in
`maintenance/identity/social_previews.py`. Regenerate all six from the workspace parent:

```bash
maintenance/.venv/bin/python -m maintenance.identity.social_previews
```

GitHub's social-preview setting still requires uploading the resulting PNG.

MediaSorter additionally uses the tight glyph as `frontend/public/icon.svg`. Desktop
bundle artwork uses `branding/app-icon.svg`, where the glyph is optically inset for macOS
and Windows icon masks. Never hand-edit generated PNG, ICO, ICNS, BMP, or DMG artwork;
change the canonical SVG/generator and run:

```bash
backend/.venv/bin/python scripts/generate_branding.py
backend/.venv/bin/python scripts/generate_branding.py --check
```
