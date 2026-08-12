# Duplicate Review Redesign

> **Status: proposal, partly adopted.** This is the reasoning behind the current
> duplicate surface, not a description of it — read
> [duplicate-review.md](duplicate-review.md) for what ships.
>
> Adopted: stacks are embedded in the destination browser and decidable there;
> one run-local decision model backs every surface; recommendations are visibly
> non-binding and never unlock Execute; ruled-out copies centralize under
> `_copies/` beside their keeper.
>
> **Not adopted: point 3 below, "remove or demote the separate Resolve mode."**
> The Open Design reference `mediasorter-final.html` keeps two tabs — a
> destination browser and a duplicate queue — because scanning a planned library
> and adjudicating one set at a time are different tasks, and the queue is what
> gives the second one a place and a sense of progress. Both tabs share the same
> decisions, selection, and sort order, which is the property this document was
> actually after.

## Product direction

Review is primarily a destination browser. It shows the planned library structure
and makes exceptions—duplicate stacks and conflicts—actionable in place.

Duplicate decisions are temporary and apply only to the current run. If duplicate
detection is enabled, every detected stack must be explicitly resolved before
Execute becomes available.

## Core interaction model

Each duplicate or conflict is represented as one stack embedded in the destination
browser. Exact duplicates, visually similar files, bursts, and other conflict
types use the same layout and controls. The evidence and explanation may differ,
but the interaction should not.

A stack contains:

- all candidate files;
- a clear recommendation, when one can be made;
- each file's size, relevant evidence, and planned destination;
- the current decision state: Needs decision or Resolved;
- controls to keep one or more files;
- a stack-level checkbox for bulk operations.

The stack remains visible and expanded after resolution. It does not disappear or
collapse automatically. The user may collapse it explicitly.

## Choosing files

When an unresolved stack opens, the recommended keeper is visibly preselected as
a suggestion. It is not yet a final decision.

Selecting a file immediately changes the decision. There is no per-stack Apply
button when the stack remains visible. The user can change the selection at any
time before Execute.

Exact duplicates recommend one keeper by default, but keeping multiple files is
always allowed. Similar and burst stacks use the same mechanism.

Choosing multiple files means all selected files remain in the normal target
hierarchy. Only files explicitly ruled out go to the duplicate area.

## Destination behavior

The plan updates immediately when a keeper changes. The browser must always remain
truthful about the current plan, but the current stack keeps focus and remains
expanded so the user is not unexpectedly moved away.

Each file card includes a compact planned-destination line. More detailed
explanation can remain available in the existing detail view.

If multiple kept files would produce the same destination name, automatic collision
suffixes are always applied, including when the collision results from identical
metadata or otherwise identical planned paths. The final names are visible during
Review.

## Ruled-out duplicates

Ruled-out files never go beside the keeper and the application must not create
scattered `_copies` directories.

They go into one centralized top-level directory inside the target:

```text
Target/
├── 2024/
├── 2025/
└── _duplicates/
    ├── 2024/
    └── 2025/
```

The hierarchy below `Target/_duplicates/` reflects the file's intended destination
hierarchy. This keeps the real library clean and makes later duplicate cleanup or
recovery manageable.

## Bulk handling

Bulk selection applies to stacks, never individual files. Stack checkboxes appear
on stack headers. Individual file controls are reserved for choosing which members
to keep inside an opened stack.

Bulk operations should include:

- the configured keeper rule, marked as the recommendation;
- alternative rules such as largest, highest resolution, newest, oldest, and
  smallest;
- a separate, visually distinct “Keep all” action.

“Keep all” means the files are treated as independent media. All of them remain
in the normal target hierarchy and receive collision suffixes where necessary.

Bulk rules affect unresolved stacks only by default. A manual decision must not be
silently overwritten. Applying a rule requires one lightweight confirmation with
the affected stack count and the fact that previously decided stacks are unchanged.
There should be no second preview step.

After application, decisions update immediately and remain editable until Execute.

## Navigation

The destination browser remains the main surface. A compact summary should expose:

- number of stacks needing a decision;
- number resolved;
- a single “Next unresolved” action.

“Next unresolved” jumps to the next unresolved stack without replacing the browser
with a second workflow.

A simple status filter keeps large runs manageable:

- All
- Needs decision
- Resolved

Normal destination navigation, search, and the status filter continue to work
together. Resolved stacks remain discoverable and editable.

## State and execution rules

The UI should use one stack decision model throughout the Review surface. Browse,
bulk handling, comparison, and destination summaries must derive from the same
run-local decisions.

Suggested states:

- `needs_decision`: no final choice has been made;
- `recommended`: a non-binding automatic suggestion is shown;
- `resolved`: one or more files have been explicitly kept, or the stack was marked
  “Keep all”.

The recommendation is presentation state, not a decision. It must never unlock
Execute by itself.

If duplicate detection is disabled, duplicate review does not block execution. If
it is enabled, every stack—including exact, similar, burst, and plan-found stacks—
must be resolved.

All decisions are run-local. They are discarded after the run and do not become
library-wide preferences.

## Implementation implications

The current Browse and Resolve modes should be consolidated around the destination
browser. The existing Resolve queue can provide the “Next unresolved” traversal
logic, but it should no longer be a second primary surface with separate selection
controls.

The implementation should then:

1. make stack selection the only bulk-selection concept;
2. keep file selection local to an opened stack;
3. remove or demote the separate Resolve mode;
4. make recommendations visibly non-binding;
5. centralize destination calculation, including `_duplicates` routing and suffixes;
6. ensure all stack types use the same decision handlers;
7. add focused tests for run-local decisions, bulk scope, keep-all behavior, stable
   navigation, and duplicate-folder destinations.

## Intentional defaults

Where the discussion left a choice open, this document chooses the least surprising
behavior:

- stacks stay open after a decision;
- the browser updates the plan immediately;
- focus stays on the edited stack;
- manual choices are never overwritten by bulk rules unless explicitly reset;
- recommendations are visible but never silently accepted;
- one confirmation is used for bulk changes, with no additional preview;
- ruled-out files are centralized under `Target/_duplicates/`.

