"""Feature gates for the catalog and profile work, and the parity they require.

Two paths exist for the same questions right now: the legacy in-memory,
single-root one and the catalog-backed, multi-root one. That duplication is the
cost of shipping the second without breaking the first, and it is deliberately
temporary — but *removing* the legacy path is a decision that needs evidence,
not a decision that happens because someone felt confident.

So the gate is here, it defaults to the safe side, and
:func:`removal_readiness` states exactly what is still missing before the old
path may go. Nothing removes it automatically.
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from typing import Literal

from app.core.catalog_schema import CATALOG_SCHEMA_VERSION
from app.core.library_profiles import PROFILE_SCHEMA_VERSION

GateName = Literal["persistent_catalog", "multi_root_profile", "catalog_backed_views"]

#: Every gate starts off. A gate that defaults on is not a gate.
DEFAULTS: dict[GateName, bool] = {
    "persistent_catalog": False,
    "multi_root_profile": False,
    "catalog_backed_views": False,
}

_ENV_PREFIX = "MEDIASORT_GATE_"


def enabled(gate: GateName, *, environ: dict[str, str] | None = None) -> bool:
    """Whether a gate is on for this process.

    Read from the environment rather than from configuration so a gate cannot be
    flipped mid-run by a settings change — a half-gated operation would be using
    two different definitions of the same library.
    """
    source = environ if environ is not None else dict(os.environ)
    raw = source.get(f"{_ENV_PREFIX}{gate.upper()}")
    if raw is None:
        return DEFAULTS[gate]
    return raw.strip().lower() in {"1", "true", "on", "yes"}


@dataclass(frozen=True)
class SchemaVersions:
    """The schema versions a gated run is bound to."""

    catalog: int = CATALOG_SCHEMA_VERSION
    profile: int = PROFILE_SCHEMA_VERSION

    def compatible_with(self, other: SchemaVersions) -> bool:
        return self.catalog == other.catalog and self.profile == other.profile


@dataclass
class ParityEvidence:
    """What has been observed about the new path against the old one.

    Every field is something a person had to run. Defaults are the honest ones:
    nothing has been observed until it has.
    """

    exact_duplicates_match: bool = False
    perceptual_duplicates_match: bool = False
    preview_rows_match: bool = False
    migration_observed: bool = False
    repeated_run_reuses_work: bool = False
    #: Sizes the new path has actually been exercised at.
    scale_runs: tuple[int, ...] = ()
    notes: list[str] = field(default_factory=list)

    @property
    def largest_scale_run(self) -> int:
        return max(self.scale_runs, default=0)


@dataclass(frozen=True)
class RemovalReadiness:
    """Whether the legacy path may be removed, and what is missing if not."""

    ready: bool
    missing: tuple[str, ...]

    @property
    def summary(self) -> str:
        if self.ready:
            return "Every parity check has been observed; the legacy path may be removed."
        return f"{len(self.missing)} parity check(s) still outstanding."


#: The scale the new path must have been exercised at before the old one goes.
REQUIRED_SCALE = 1_000_000


def removal_readiness(evidence: ParityEvidence) -> RemovalReadiness:
    """State plainly what still stands between here and deleting the old path."""
    missing: list[str] = []
    if not evidence.exact_duplicates_match:
        missing.append("exact-duplicate results have not been shown to match")
    if not evidence.perceptual_duplicates_match:
        missing.append("perceptual results have not been shown to match")
    if not evidence.preview_rows_match:
        missing.append("preview rows have not been shown to match")
    if not evidence.migration_observed:
        missing.append("a real profile migration has not been observed")
    if not evidence.repeated_run_reuses_work:
        missing.append("a repeated run has not been shown to reuse its work")
    if evidence.largest_scale_run < REQUIRED_SCALE:
        missing.append(
            f"the new path has only been exercised at {evidence.largest_scale_run:,} records, "
            f"below the {REQUIRED_SCALE:,} required"
        )
    return RemovalReadiness(ready=not missing, missing=tuple(missing))


def active_gates(*, environ: dict[str, str] | None = None) -> dict[GateName, bool]:
    return {gate: enabled(gate, environ=environ) for gate in DEFAULTS}


def describe() -> str:
    """One line for the diagnostics endpoint."""
    active = [name for name, on in active_gates().items() if on]
    if not active:
        return "No rollout gates are enabled; the established paths are in use."
    return f"Enabled rollout gates: {', '.join(sorted(active))}."
