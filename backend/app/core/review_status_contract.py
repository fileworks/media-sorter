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
CONTRACT_FORMAT_VERSION: Final = 1

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


class ReviewStatusContract(TypedDict):
    """The serialized shape of ``contracts/review-statuses.json``."""

    format_version: int
    generated_by: str
    source_of_truth: str
    planned_quarantine_statuses: list[str]
    non_quarantining_preview_statuses: list[str]
    preview_statuses: list[str]


def contract_payload() -> ReviewStatusContract:
    """Build the artifact payload. Sorted throughout so the output is stable."""
    return ReviewStatusContract(
        format_version=CONTRACT_FORMAT_VERSION,
        generated_by="scripts/generate_review_status_contract.py",
        source_of_truth="backend/app/core/review_status_contract.py",
        planned_quarantine_statuses=sorted(PLANNED_QUARANTINE_STATUSES),
        non_quarantining_preview_statuses=sorted(NON_QUARANTINING_PREVIEW_STATUSES),
        preview_statuses=sorted(PREVIEW_STATUSES),
    )
