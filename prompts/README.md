# Focused agent task prompt

The current entry point is [AGENTS.md](../AGENTS.md). Old one-off implementation
prompts are not maintained task lists. Use this template with a concrete change:

```text
Work on MediaSorter: [desired result and affected area].
Read AGENTS.md and follow only the relevant task route. Private workspace notes
are optional; use them only if present and needed. Reuse recorded decisions and
ask only for missing information that materially changes the work.
Inspect the affected code/tests, implement the bounded change, and run its
appropriate checks. Preserve the documented safety and ownership contracts.
Update affected user/developer docs and lasting decisions in the same change.
Report the changed behavior, actual check output/skips and any remaining blocker.
Do not publish a release, move tags or add AI authorship without authorization.
```
