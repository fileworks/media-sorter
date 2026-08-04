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

A bulk command names its scope — This group, Selected groups, Current filtered exact
groups, or All unresolved exact groups — and is previewed against a frozen
`scope_generation` built from the catalog generation, the rule version, the plan
version, and the active filter. If any of those move before the command is confirmed,
applying it raises rather than acting on a set the user never saw. Similar groups are
always excluded from exact policies, and the preview says so.

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
