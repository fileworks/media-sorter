"""The preview status vocabulary, exported as data rather than as a type.

`PLANNED_QUARANTINE_STATUSES` in :mod:`app.core.sort_plan` answers exactly one
question — *does this file go to a review folder?* — and owns the answer. The
frontend needs the whole vocabulary, quarantining or not, and its TypeScript
union cannot supply it: a union is erased at build time, so no runtime check can
compare the two. That is why the two sets were free to drift.

So the vocabulary is exported here as data,
``scripts/generate_review_status_contract.py`` freezes it into
``contracts/review-statuses.json``, and the backend test, the frontend test and
CI all compare against that one artifact.

The relation the contract pins is **subset**, not equality. The frontend union is
the quarantining set plus exactly the four statuses below, which deliberately do
*not* send a file to a review folder. Enumerating them is the point: a fifth one
cannot appear without a deliberate edit here, which is what "silent drift" means
in practice.
"""

from __future__ import annotations

from typing import Final, TypedDict

from app.core.sort_plan import PLANNED_QUARANTINE_STATUSES

#: Bumped only when the artifact's *shape* changes, never when a status is
#: added — a status change must show up as a content diff the reader can see.
#: 2 added ``operation_record_statuses``.
CONTRACT_FORMAT_VERSION: Final = 2

#: Preview statuses that leave a file where the ordinary sort would put it.
#:
#: * ``sort`` — the ordinary dated destination (`preview_service._build_dest_path`).
#: * ``duplicate_unknown`` — the real sort may still route this file as a
#:   duplicate, so preview promises no destination at all.
#: * ``review_only`` — `config.sort` is off; nothing moves.
#: * ``keep_in_place`` — `deduplicate_only` and not a duplicate or junk, so the
#:   input tree is left exactly as it was found.
NON_QUARANTINING_PREVIEW_STATUSES: Final = frozenset(
    {
        "sort",
        "duplicate_unknown",
        "review_only",
        "keep_in_place",
    }
)

#: Every status a preview item may carry. Disjoint union of the two sets above.
PREVIEW_STATUSES: Final = PLANNED_QUARANTINE_STATUSES | NON_QUARANTINING_PREVIEW_STATUSES

#: Every status the executor writes into a `FileOperationRecord`.
#:
#: This is a *different* vocabulary from the preview one above — a preview says
#: where a file would go, a record says what happened to it — and it had no
#: contract at all. The report screen filters on these strings, so a status the
#: executor writes and the filter does not know about simply vanishes from every
#: tab while still being counted in "All". That is how `companion_left_in_place`
#: and `kept_in_place` came to be invisible, and how `unmatched_companion` came
#: to be filtered for despite never being written.
#:
#: `test_review_status_contract` pins this against the literals in
#: :mod:`app.services.sorting_service`, so adding one there without adding it
#: here fails the backend suite rather than quietly emptying a filter.
OPERATION_RECORD_STATUSES: Final = frozenset(
    {
        # Placed at its reviewed destination and verified.
        "success",
        # Deliberate non-moves. Both are successful outcomes in which nothing
        # was transferred, which is why neither belongs under "Sorted".
        "kept_in_place",
        "companion_left_in_place",
        # Routed to a review folder rather than the dated destination.
        "already_in_destination",
        "corrupted",
        "duplicate",
        "future_date",
        "junk",
        "unknown_date",
        # Did not complete.
        "blocked",
        "cancelled",
        "failed",
        "incomplete_unit",
    }
)


class ReviewStatusContract(TypedDict):
    """The serialized shape of ``contracts/review-statuses.json``."""

    format_version: int
    generated_by: str
    source_of_truth: str
    planned_quarantine_statuses: list[str]
    non_quarantining_preview_statuses: list[str]
    preview_statuses: list[str]
    operation_record_statuses: list[str]


def contract_payload() -> ReviewStatusContract:
    """Build the artifact payload. Sorted throughout so the output is stable."""
    return ReviewStatusContract(
        format_version=CONTRACT_FORMAT_VERSION,
        generated_by="scripts/generate_review_status_contract.py",
        source_of_truth="backend/app/core/review_status_contract.py",
        planned_quarantine_statuses=sorted(PLANNED_QUARANTINE_STATUSES),
        non_quarantining_preview_statuses=sorted(NON_QUARANTINING_PREVIEW_STATUSES),
        preview_statuses=sorted(PREVIEW_STATUSES),
        operation_record_statuses=sorted(OPERATION_RECORD_STATUSES),
    )
