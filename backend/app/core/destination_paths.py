"""Where a planned file goes — pure path policy, no I/O and no services.

`core/sort_plan.py` imported these from `app.services.destination` and
`app.services.outcome_provenance`, which inverted the dependency the rest of the
codebase maintains: `core` holds the rules, `services` performs the work. The
cycle was type-only in practice, but it meant the plan model could not be
imported without dragging in the conversion service, the extraction service and
the AI classifier behind them.

Everything here is a pure function of its arguments or a constant. The only
exception is `reserve_destination`, which consults the filesystem to avoid
colliding with a file that already exists — that is a *read*, and the collision
rule it implements is policy rather than work.

`services/destination.py` and `services/outcome_provenance.py` re-export these
names, so every existing import keeps working.
"""

from __future__ import annotations

from pathlib import Path

from app.core.provenance import OutcomeProvenance, PathSegmentProvenance
from app.utils.path_utils import sanitize_path_segment

#: Which review folder each non-sorting outcome is placed under. Read by
#: `quarantine_dir`, and by the catalog when recognising folders older versions
#: created.
QUARANTINE_FOLDERS: dict[str, str] = {
    "unknown": "_undated",
    "future": "_undated",
    "failed": "_corrupted",
    "corrupted": "_corrupted",
    "junk": "_junk",
}

#: Where a duplicate copy is placed, beside the keeper it follows.
CONTEXTUAL_COPY_FOLDER = "_copies"


def copy_destination(
    keeper_destination: Path,
    keeper_source: Path,
    copy_source: Path,
    source_root: Path,
) -> Path:
    """Return the contextual, unreserved destination for a duplicate copy.

    The caller applies the shared collision reservation, exactly as for every
    other planned path. The leaf name makes both relationships readable on
    disk: which file won and which input root supplied this copy.
    """
    if keeper_destination.parent.name == CONTEXTUAL_COPY_FOLDER:
        raise ValueError("a duplicate keeper cannot itself be inside _copies")

    root_label = sanitize_path_segment(source_root.name) or "source"
    keeper_label = sanitize_path_segment(keeper_source.stem) or "keeper"
    filename = f"{keeper_label} — from {root_label}{copy_source.suffix}"
    return keeper_destination.parent / CONTEXTUAL_COPY_FOLDER / filename


def reserve_destination(path: Path, reserved: set[Path]) -> Path:
    """Return and reserve the first collision-free deterministic path."""
    candidate = path
    stem, suffix = path.stem, path.suffix
    counter = 0
    while candidate.exists() or candidate.resolve(strict=False) in reserved:
        counter += 1
        candidate = path.parent / f"{stem}_{counter:03d}{suffix}"
    reserved.add(candidate.resolve(strict=False))
    return candidate


def companion_destination(primary_destination: Path, companion: Path) -> Path:
    """Place a member beside its primary, inheriting its final collision stem."""
    return primary_destination.with_name(primary_destination.stem + companion.suffix)


def contextualize_copy(
    provenance: OutcomeProvenance,
    *,
    destination: Path,
    destination_root: Path,
    keeper: Path,
) -> OutcomeProvenance:
    """Attribute the actual keeper-relative path without borrowing the copy's date.

    A copy whose own metadata says 2021 can legitimately follow a keeper into
    2019. Reusing the ordinary date segments would therefore be a persuasive
    lie. Each inherited folder is explicitly attributed to the keeper instead.
    """
    try:
        relative = destination.relative_to(destination_root)
    except ValueError:
        relative = destination
    parts = relative.parts
    contextual = [
        PathSegmentProvenance(
            segment=segment,
            decision="quarantine",
            detail=f"follows kept copy {keeper.name}",
        )
        for segment in parts[:-1]
    ]
    if parts:
        contextual.append(
            PathSegmentProvenance(
                segment=parts[-1],
                decision="original_name",
                detail=f"named for kept copy {keeper.stem} and its source root",
            )
        )
    return provenance.model_copy(update={"path": tuple(contextual[:16])})
