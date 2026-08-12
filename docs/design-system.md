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
| Success | `success`, `decor-success`, `tint-success` | verified, recommended, complete |
| Warning | `warning`, `decor-warning`, `tint-warning` | caution and meaningful differences |
| Error | `error`, `destructive`, `tint-error` | failure or destructive action only |
| Information | `info`, `tint-info` | neutral information and read-only references |
| Structure | `border`, `input`, `ring` | boundaries, form edges, and keyboard focus |

`brand`, `decor-success`, and `decor-warning` are decorative. Text uses the matching
contrast-tested semantic token. Focus is always a visible two-pixel `ring` treatment.

## Geometry and typography

- Geist Sans is the UI family; Geist Mono is reserved for paths, filenames, values,
  ordinals, and shortcuts. Both are bundled locally.
- The body is 13px. Screen headings are 22px on a full viewport and remain at least
  20px on compact viewports. Section headings are 14–18px; metadata never drops below
  10px.
- Spacing follows a 4px base. The dominant rhythm is 8 / 12 / 16 / 20px.
- Standard cards use a 12px radius, one-pixel border, and no shadow. Shadows are reserved
  for dialogs, toasts, and primary-action emphasis.
- The workspace is capped at 1480px (`max-w-workspace`). The shell rails are 54px for
  the title bar, 76px on wide desktop / 68px on tablet for the stepper, and at least
  60px for the action bar.
- Controls are at least 32px high, and at least 44px on coarse pointers when a dense
  desktop arrangement is not required.

## Workflow and component rules

The visible flow is Sources → Recipe → Configure → Plan → Review → Execute. Every screen
has one `ScreenHeader`, one persistent primary action at the bottom right, and a quiet
safety or estimate sentence in the footer. Plan is a read-only impact checkpoint. Review
has destination-browse and duplicate-decision modes; recommendations are green and
dashed, while a confirmed keeper is orange and solid.

Use the shared `Button`, `Select`, `Input`, `Toggle`, `Modal`, `Tooltip`, `SettingRow`,
and `StateView` before adding local control chrome. A component owns its layout; global
CSS owns tokens, native control normalization, and motion accessibility.

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
