# Duplicate review, validation, and quarantine

This is the contract behind every screen that decides which copy of a file survives. It
exists because the failure mode here is not a crash — it is a confidently deleted
original.

## Three separations that are enforced, not assumed

**Evidence is not action.** What the system measured lives in `MemberEvidence`;
what a person decided lives in `Decision`. Recomputing a signature can never change
somebody's choice, and a choice can never invent evidence.

**Exact is not similar.** An exact group that quarantines anything has exactly
one canonical keeper — the model refuses to construct one that does not. A similar group
may keep several members, and its *representative* is a comparison anchor rather than a
retention decision. Choosing a new representative quarantines nothing.

**Reference is not input.** A reference member cannot hold a mutating decision:
`ReviewPlan.decide` refuses it, `_outcome_for` resolves it to `no_action_reference`, and
`executable_members` only ever returns mutating outcome kinds. A handcrafted API request
meets the same guard the UI does — the API test suite asserts exactly that.

## Facts, and the absence of facts

`FactValue` is either known or explicitly not, with the reason attached. An unknown
dimension is never rendered as zero, because "keep the highest resolution" would then
quietly discard the one copy whose dimensions failed to read. The `highest_resolution`
policy refuses to decide a group where any member is unmeasured, and sends it to review
instead.

## Keeper policies

| Policy | Decides by | Tie-breakers, in order |
|---|---|---|
| `best_quality` *(default)* | pixel count | byte size, newest modification time, then stable identity |
| `largest` / `smallest` | byte size | newest modification time, then stable identity |
| `newest` / `oldest` | modification time | larger file, then stable identity |
| `highest_resolution` | pixel count | larger file, then stable identity |
| `longest_filename` / `shortest_filename` | file-name length | larger file, then stable identity |
| `preferred_root` | configured root order | larger file, then stable identity |
| `protected_reference` | a reference in the group | first by stable identity |
| `manual` | nothing — always sends the group to review | — |

Two refusals matter more than the choices. `highest_resolution` refuses a group whose
dimensions could not all be read, rather than treating an unknown as the smallest and
quarantining the one good copy; `best_quality` falls back to size for those, because a
library is full of files no decoder can measure and refusing them all would leave the
common case undecided. `preferred_root` and `protected_reference` refuse when no member
qualifies.

Stable identity is `root:relative_path:member_id`, which makes every policy produce the
same keeper on a rerun regardless of scan order. A protected reference anchors the group
ahead of any other criterion, because it is the one copy that cannot be touched.

The same rules are implemented on the client, in `reviewWorkbench.ts::keeperByPolicy`,
tie-break for tie-break. That lets Review rank a large catalog immediately without making
the ranking binding. The two implementations are held to each other by tests on both
sides; changing a tie-break in one without the other is a bug in both.

## What the interface asks

**A set has one of three states everywhere:** *undecided*, *proposed*, or *decided*.
A configured rule ranks every catalog-backed set it can when Review opens, but that result
is only a proposal. It changes no frozen action and sends nothing through `reviewed_sets`
until it is accepted. The whole proposal batch or one set can be accepted; changing the
rule replaces only outstanding proposals, and every accepted result remains overridable.

The three states wear three colours and are told apart without reading a word: `primary`
for undecided, `suggest` for proposed, `success` for decided. A proposal and a decision
shared one green until recently, which made a plan of untaken offers look finished.

**A set is decidable wherever it is found.** Expanding one in Browse puts every copy side
by side with its resolution, megapixels, size, source folder, capture date and provenance.
The comparison uses the available window and the pair's aspect ratio; either side opens
full screen and returns to the unchanged comparison. Video pairs additionally show duration
and codec. Unknown measurements stay unknown and never create a winner.

Resolve remains, for the other shape of the same task: working through twelve sets in
sequence rather than meeting one while browsing. It shows one set at a time, and every
decision is a single gesture on the copy it decides. Activating a copy — by pointer or by
its number key — keeps it and moves to the next set still open. Left and right move
between sets, and nothing in it needs a pointer.

There is no confirmation step. There used to be: a copy was *drafted* and a separate
"Confirm selection" control in a bar at the bottom of the pane committed it, which put the
decision as far from the copies as the layout allowed, cost two presses per set, and was
itself the "separate command control that acts on the set without naming the copy it would
choose" the surface's contract forbids. Nothing here is irreversible, so nothing here is
confirmed: the set states what it decided, in the same band, and clears it in one press.

A copy row leads with the two facts that can actually differ between byte-identical
members — the source folder, and the recorded date with its provenance. Size and planned
destination follow in one quiet line, because for an exact set they are the same value
printed once per copy. Keep and Compare sit on the copy; Compare names the copy it would
put beside it, which for a pair is simply the other one.

The list, the position, and the arrow keys all read one order — the one the sort control
sets. A counter that named a row twelve places down the list was worse than no counter.
Both surfaces route through the same handlers, so there is one decision
path and not two. The command `<select>` that used to sit in each set's header is gone; it
offered a *rule* to a person who had already looked at the pictures.

The strip above the queue holds the two ways a set gets decided, and only those: the
rule's offer with the rule that makes it on the left, and the selection with what to do
with it on the right. Everything that acts on the *list* rather than on a decision — its
order, walking to the next open set, clearing what has been decided — sits in the list's
own header. Selecting all and clearing that selection had ended up on opposite sides of
the screen; they are two halves of one gesture and are both in the strip.

**The keep rule never leaves the screen, and the action beside it is named after the rule
it runs.** The rule used to sit inside the half of the strip that swaps out when a set is
ticked, so selecting sets for a bulk decision removed the control that decided them — and
the dialog that opened next silently applied the rule that had just vanished. It now sits
outside that swap, and both bulk dialogs carry it as an operand, so whichever door the
decision is taken through, the rule about to run is on screen and adjustable. The button
that takes the rule's offer over every open set reads "Apply to *N* open sets", not
"Accept *N* recommendations": accepting is not a second, cleverer algorithm standing next
to the keep rule, it *is* the keep rule, run over every set nobody has answered — and the
old name implied otherwise on the one screen where the distinction matters.

**The list marks what is done and what a bulk action covers.** A decided set loses its
status dot and takes a check: a dot is a claim on attention, and a finished set is not
making one. Sets ticked for a bulk action are checked and tinted in the list itself, so
"5 sets selected" names five rows a reader can see rather than five rows they have to
take on trust.

A comparison opened on a set of three or more copies steps through every *pair*, not
every other copy against a fixed first one — that arrangement could never put the second
copy beside the third, which is the comparison a person reaches for once they have ruled
the first out. **Each copy is lettered — A, B, C — for as long as its set is open**, and
the letters name the *copies*, not the sides of the screen: lettering by position meant
stepping from one pair to the next silently redefined "A", so the badge over the image,
the keeper radio and the fact column all changed meaning mid-comparison with nothing
saying so. Every pairing is listed as a chip (`A ↔ B`, `A ↔ C`, `B ↔ C`) with the current
one marked, so the whole matrix is one press away rather than a ring to be walked. How
you are looking — side-by-side, difference, the slider, the zoom — survives a change of
pair and of set; only the draft keeper, which is a fact about *these two copies*, resets.

Every decision covering more than one set states its impact before it acts, in one dialog
rather than as counts crammed onto a toolbar button. The dialog names the scope, then gives
each action its own sentence, its own operand, and — on its button, not on hover — the
number of sets it would decide.

It also states what the decision does to the *files*, which is the part being agreed to: a
count of sets is a count of decisions, not of consequences. Each action says how many copies
are set aside and how much that frees, and refuses to state a total where one copy has no
measured size — a figure that silently treats an unmeasured file as zero has the same shape
as a true one. Every count is read from live props, so changing the folder, or a selection
changing underneath, restates the impact instead of leaving the last one's figures beside a
different choice. The selection-scoped actions are:

- apply the current keep rule to exactly the selected sets;
- mark the selected sets as different files, keeping every member independently; or
- keep the unique copy from a source folder present in the selection.

**Browse is sufficient on its own.** A reader who does not care which copy survives can
finish an entire run without opening Resolve: Browse states how many sets are still open,
how many the rule can rank and how many need a person, and offers both the batch
acceptance and the selection-scoped actions from the same dialogs Resolve uses. Accepting
never overwrites a decision somebody made by hand and never touches a set whose keeper is
fixed by a reference root; the result shows up immediately in the destination tree, as the
sets leave the "stays where it is" branch for the folders their keepers land in.

The selection-scoped “not duplicates” action is the bounded path through any catalog,
including hundreds of burst or plan-found sets no rule can rank. No Review action excludes
individual files; run scope remains directory-only on Sources.

Two kinds of set a rule cannot decide are counted and explained rather than represented by
a disabled command on every set:

- **Similar and burst sets.** A visual match is not proof that two files are the same file.
- **Sets the dry run found for itself.** The rules rank copies by measured facts — pixels,
  bytes, modification time — and those live on the catalog's member records. A set that
  exists only because `PreviewService` matched it against the run registry has none, so
  ranking it would pick a keeper on grounds the user was never shown. See
  `planDuplicateSets` in `lib/reviewRows.ts`.

A set with a protected reference is never *open*: the baseline wins, there is nothing to
choose, and "Next open" passes over it. It is still listed and still reachable — from Browse,
or with the arrow keys — and shows the reference marked protected and says so. No surface
offers it a keeper decision, and a stale decision naming one is ignored rather than applied.

**An outstanding set is visible before the run, not after it.** Browse separates proposals
from undecided sets under *Stays where it is*. Both bind nothing, both count toward the one
outstanding total, and Execute remains unavailable until every set is decided. Protected
reference sets do not count because their immutable reference already answers the question.

## Two detections, one set of sets

There are two duplicate detections and they are independent. `PreviewService._preview_file`
matches each file against the run's `DuplicateRegistry` and, on a hit, marks it `duplicate`
and addresses it beside its keeper under `_copies/`. The catalog behind `GET /api/review/groups` is a
separate query with its own persistent identity.

Only the catalog ever produced a `RowStack`, so a file the run was setting aside with no
catalog group covering it reached the screen belonging to nothing: counted in no set,
offered in no queue, and decidable by nothing — while the summary said the run held no
duplicate sets at all. `planDuplicateSets` rebuilds those sets from the plan's own
`duplicate_of` links, and `toReviewRows` merges them in.

The catalog wins any overlap. It is the durable identity, and it is what a decision made
here survives as; `duplicateTally` claims members strongest-first and skips a set with fewer
than two unclaimed ones, which is what counts a file in both exactly once. A **partial**
overlap stays two sets on purpose — the copies the catalog does not hold still need
deciding, and folding them in would hide a decision rather than reconcile one.

## How a keeper decision reaches the run

One mechanism, end to end:

1. The choice is held on the Review screen as **run state**. It is not persisted and not
   sent anywhere until the run starts. Folder scope is decided earlier on Sources and is
   sent independently to scan, analysis, preview, catalog queries and execution.
2. `POST /api/sorting/start` receives it as `reviewed_sets: [{ keep, demote[] }]`. Both
   halves are needed: promoting a copy also demotes whichever copy the plan was going to
   place, so a decision is two changed actions, not one.
3. `FrozenSortPlan.with_reviewed_sets()` derives a new plan in which the chosen copy uses
   its recorded own destination and every other member follows it into that folder's
   `_copies/` leaf. This remains exact across different dates and source-relative folders;
   the stored plan is never edited.
4. The run's `DuplicateRegistry` is seeded from the same sets, so the "first seen wins"
   keeper and the whitelisted action come from one input and cannot disagree.

“Not duplicates” uses the same wire record with `keep_all: true`. The derived plan restores
every member's own destination, and the run keeps those members out of its run-local
duplicate registry so identical bytes are not collapsed again. Destination-library matches
still apply: this decision does not authorize duplicating content already present there.

One promotion is refused rather than approximated, because a half-unit would be data loss:

- **Members carrying different companion files.** Demoting a RAW+JPEG pair under a lone
  JPEG would leave the sidecar bound to a different primary.

The conflict names both files and keeps the reviewed plan unchanged. To omit one side, go
back to Sources, skip its configured folder, and rebuild the whole plan; Review never drops
individual files. Different source folders are safe because preview records every member's
own complete destination before Review.

The whole set always follows its keeper. If members resolve to different dates, the
keeper's date wins for placement while each loser's own date, source root, and would-be
destination remain in the manifest and report. An undated or junk keeper applies the same
rule: its copies land under `_undated/_copies/` or `_junk/_copies/`.

## Similar media

Perceptual groups require review by default. The optional high-confidence rule is off
until a user enables it, is *versioned* (changing the threshold or evidence scope
invalidates the consent that was given), proposes **quarantine only**, and refuses any
group where confidence is low, distances exceed the configured maximum, media kinds
differ, or dimensions differ or are unknown. `preview_rule` shows what enabling it would
affect before consent is asked for.

## Concrete outcomes

Decisions are resolved against the role and the Copy/Move mode:

| Decision | Input under Copy | Input under Move | Destination | Reference |
|---|---|---|---|---|
| keep | copied, source retained | moved after verification | left in place | no action |
| quarantine | **changes your input** — needs acknowledgement | moved to quarantine | moved to quarantine | refused |
| skip | left in place | left in place | left in place | no action |

Quarantining an *input* file under Copy is singled out because Copy mode is a promise
that the input is left alone. That promise is only broken with a separate
acknowledgement, and `PlanSnapshot` refuses to exist without one.

## Bulk scopes

The desktop run-state actions have two explicit scopes: all outstanding proposals, or the
selected sets. A selected action derives its impact from the live selection on every render,
so a changed selection changes the confirmation rather than applying to an unseen scope.
Catalog-plan API bulk commands additionally freeze their `scope_generation`; if the catalog,
rule, plan, or filter changes before application, the server refuses the stale command.

## Drift

Before execution, stored groups are compared with what the catalog says now. Changed
content, a changed role, a moved path, a changed size, a vanished group, or a changed
rule version each mark the group `stale`. Stale groups return to review and are excluded
from the execution snapshot entirely — a snapshot never contains a decision made about a
file that has since changed.

## Validation

Seven independent validators: misplaced files, inconsistent names, exact duplicates,
similar media, unreadable media, missing sidecars, and catalog staleness. Each reports
`failed`, `passed`, `disabled`, `not_evaluated`, or `unknown` — a turned-off check is
never reported as passing, and an empty root is `not_evaluated` rather than clean.

A report with any unreachable scope is `partial` forever: `certifies_whole_library`
returns `False` no matter how many checks passed. Only findings marked `actionable`
(misplaced files and exact duplicates) may be converted into ordinary review actions.

## Quarantine and permanent removal

Quarantine records carry the original path, identity, hash, reason, keeper link,
operation, and retention state. `preview_restore` reports the target, any conflict, and
whether the quarantined bytes still match their recorded hash before anything moves; a
conflict is never resolved by overwriting.

`preflight` checks plan freshness, conflicts, quarantine writability, and free space
with a 25% margin that counts the quarantine copy — because "it fit exactly" is how a
run ends half-done.

Permanent removal is a **separate task**. It works from a frozen impact preview,
requires its own acknowledgement, excludes anything already restored, can be cancelled
between files, and produces a terminal report. It is the only path in the application
that destroys anything, and it is never part of ordinary duplicate execution.
