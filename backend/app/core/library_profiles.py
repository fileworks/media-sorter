"""Versioned contracts for media-library profiles and scalable operations.

The existing :class:`app.core.config.Config` remains the compatibility surface
while the multi-root implementation is introduced.  This module contains the
durable contracts that may be persisted, transported through the API, and
snapshotted by catalog operations.  Every persisted model carries an explicit
version so later migrations never need to infer its shape.
"""

from __future__ import annotations

from datetime import datetime, timezone
from typing import Generic, Literal, TypeVar

from pydantic import BaseModel, ConfigDict, Field, JsonValue, model_validator

PROFILE_SCHEMA_VERSION: Literal[1] = 1
ROOT_IDENTITY_SCHEMA_VERSION: Literal[1] = 1
CHECKPOINT_SCHEMA_VERSION: Literal[1] = 1

RootRole = Literal["input", "reference", "destination"]
TransferMode = Literal["copy", "move"]
CatalogMode = Literal["application_data", "portable"]
IdentityConfidence = Literal["high", "medium", "path_only", "unresolved"]
ConfigScope = Literal["application", "profile", "run"]
ConfigValueSource = Literal["default", "application", "profile", "run"]
InvalidationTarget = Literal[
    "none",
    "query",
    "planning",
    "derived_media",
    "discovery",
]
ProgressMode = Literal["indeterminate", "determinate"]
CheckpointState = Literal["active", "paused", "cancelled", "completed", "failed"]
CatalogFreshnessState = Literal["fresh", "stale", "partial", "offline", "unknown"]
RootAvailability = Literal["online", "offline", "inaccessible", "not_directory"]


class RootIdentity(BaseModel):
    """Best available evidence that a configured root is the same filesystem root.

    ``canonical_path`` is location evidence, not permanent identity.  Platform
    implementations progressively fill stronger fields such as ``volume_id``
    and ``root_file_id``.  A path-only identity is deliberately labelled as
    lower confidence so callers cannot silently treat a mount-path match as
    authoritative.
    """

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = ROOT_IDENTITY_SCHEMA_VERSION
    confidence: IdentityConfidence = "unresolved"
    canonical_path: str
    volume_id: str | None = None
    filesystem_id: str | None = None
    root_file_id: str | None = None
    platform: str | None = None
    observed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class RootProbe(BaseModel):
    """Result of resolving one configured root without mutating it."""

    model_config = ConfigDict(frozen=True)

    configured_path: str
    availability: RootAvailability
    identity: RootIdentity
    error_code: str | None = None


class LibraryRoot(BaseModel):
    """One role-bearing location inside a saved library profile."""

    model_config = ConfigDict(frozen=True)

    root_id: str = Field(min_length=1, max_length=128)
    role: RootRole
    path: str = Field(min_length=1)
    display_name: str | None = Field(default=None, max_length=200)
    priority: int = Field(default=0, ge=0)
    exclusions: list[str] = Field(default_factory=list)
    identity: RootIdentity | None = None


class CatalogPlacement(BaseModel):
    """Where the catalog for a profile is stored.

    The application-data path is resolved internally and is never persisted in
    the profile.  Portable mode stores only a safe relative filename beside the
    exported profile, never an arbitrary media-library path.
    """

    model_config = ConfigDict(frozen=True)

    mode: CatalogMode = "application_data"
    relative_path: str | None = None

    @model_validator(mode="after")
    def validate_portable_path(self) -> CatalogPlacement:
        if self.mode == "application_data" and self.relative_path is not None:
            raise ValueError("application-data catalogs cannot carry a relative path")
        if self.mode == "portable":
            if not self.relative_path:
                raise ValueError("portable catalogs require a relative path")
            candidate = self.relative_path.replace("\\", "/")
            if candidate.startswith("/") or ":" in candidate or ".." in candidate.split("/"):
                raise ValueError("portable catalog path must stay beside the profile")
        return self


class ResourcePreferences(BaseModel):
    """Bounded user preference for resource scheduling."""

    model_config = ConfigDict(frozen=True)

    mode: Literal["auto", "conservative", "custom"] = "auto"
    memory_limit_mib: int | None = Field(default=None, ge=128)
    io_workers: int | None = Field(default=None, ge=1, le=32)
    cpu_workers: int | None = Field(default=None, ge=1, le=64)

    @model_validator(mode="after")
    def custom_requires_a_limit(self) -> ResourcePreferences:
        if self.mode == "custom" and all(
            value is None for value in (self.memory_limit_mib, self.io_workers, self.cpu_workers)
        ):
            raise ValueError("custom resource mode requires at least one limit")
        return self


class LibraryProfile(BaseModel):
    """Versioned saved profile with role-aware roots and catalog placement."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = PROFILE_SCHEMA_VERSION
    profile_id: str = Field(default="default-library", min_length=1, max_length=128)
    name: str = Field(default="Default library", min_length=1, max_length=200)
    roots: list[LibraryRoot] = Field(default_factory=list)
    transfer_mode: TransferMode = "move"
    catalog: CatalogPlacement = Field(default_factory=CatalogPlacement)
    resources: ResourcePreferences = Field(default_factory=ResourcePreferences)

    @model_validator(mode="after")
    def validate_root_contract(self) -> LibraryProfile:
        root_ids = [root.root_id for root in self.roots]
        if len(root_ids) != len(set(root_ids)):
            raise ValueError("library root ids must be unique")
        destinations = [root for root in self.roots if root.role == "destination"]
        if len(destinations) > 1:
            raise ValueError("a library profile can contain at most one destination")
        return self

    @property
    def inputs(self) -> list[LibraryRoot]:
        return [root for root in self.roots if root.role == "input"]

    @property
    def references(self) -> list[LibraryRoot]:
        return [root for root in self.roots if root.role == "reference"]

    @property
    def destination(self) -> LibraryRoot | None:
        return next((root for root in self.roots if root.role == "destination"), None)

    @classmethod
    def from_legacy(
        cls,
        *,
        source_directory: str,
        target_directory: str,
        copy_instead_of_move: bool,
    ) -> LibraryProfile:
        """Create the stable default profile represented by historical fields."""
        roots: list[LibraryRoot] = []
        if source_directory:
            roots.append(
                LibraryRoot(
                    root_id="input-1",
                    role="input",
                    path=source_directory,
                    priority=0,
                )
            )
        if target_directory:
            roots.append(
                LibraryRoot(
                    root_id="destination",
                    role="destination",
                    path=target_directory,
                )
            )
        return cls(
            roots=roots,
            transfer_mode="copy" if copy_instead_of_move else "move",
        )

    def with_legacy_directories(
        self,
        *,
        source_directory: str,
        target_directory: str,
        copy_instead_of_move: bool,
    ) -> LibraryProfile:
        """Update the compatibility input/destination without losing references.

        This adapter is used only while the legacy folder controls remain
        shipped.  Additional input roots and all reference roots survive; the
        first input and the sole destination mirror the historical fields.
        """
        roots = list(self.roots)
        input_indexes = [index for index, root in enumerate(roots) if root.role == "input"]
        if source_directory:
            replacement = LibraryRoot(
                root_id=roots[input_indexes[0]].root_id if input_indexes else "input-1",
                role="input",
                path=source_directory,
                priority=roots[input_indexes[0]].priority if input_indexes else 0,
                exclusions=roots[input_indexes[0]].exclusions if input_indexes else [],
                display_name=roots[input_indexes[0]].display_name if input_indexes else None,
            )
            if input_indexes:
                roots[input_indexes[0]] = replacement
            else:
                roots.insert(0, replacement)
        elif input_indexes:
            roots.pop(input_indexes[0])

        destination_index = next(
            (index for index, root in enumerate(roots) if root.role == "destination"),
            None,
        )
        if target_directory:
            replacement = LibraryRoot(
                root_id=(
                    roots[destination_index].root_id
                    if destination_index is not None
                    else "destination"
                ),
                role="destination",
                path=target_directory,
                display_name=(
                    roots[destination_index].display_name if destination_index is not None else None
                ),
            )
            if destination_index is None:
                roots.append(replacement)
            else:
                roots[destination_index] = replacement
        elif destination_index is not None:
            roots.pop(destination_index)

        return self.model_copy(
            update={
                "roots": roots,
                "transfer_mode": "copy" if copy_instead_of_move else "move",
            }
        )


class ConfigSettingContract(BaseModel):
    """Presentation-neutral metadata for a configurable value."""

    model_config = ConfigDict(frozen=True)

    key: str
    scope: ConfigScope
    source: ConfigValueSource
    invalidates: InvalidationTarget = "none"
    sensitive: bool = False


class RunOverrides(BaseModel):
    """Temporary values layered over a saved profile for one operation."""

    model_config = ConfigDict(frozen=True)

    values: dict[str, JsonValue] = Field(default_factory=dict)


class EffectiveProfileSnapshot(BaseModel):
    """Immutable profile/config identity attached to catalog and plan work."""

    model_config = ConfigDict(frozen=True)

    profile: LibraryProfile
    run_overrides: RunOverrides = Field(default_factory=RunOverrides)
    effective_config_hash: str = Field(min_length=64, max_length=64)
    created_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class CatalogFreshness(BaseModel):
    """Freshness of one cataloged root at a specific generation."""

    model_config = ConfigDict(frozen=True)

    root_id: str
    state: CatalogFreshnessState = "unknown"
    generation: int | None = Field(default=None, ge=0)
    last_complete_scan_at: datetime | None = None
    issue_count: int = Field(default=0, ge=0)


class ResultPageRequest(BaseModel):
    """Stable cursor request; the cursor body remains opaque to clients."""

    model_config = ConfigDict(frozen=True)

    cursor: str | None = None
    limit: int = Field(default=100, ge=1, le=500)
    sort: str = "path"
    descending: bool = False


ItemT = TypeVar("ItemT")


class ResultPage(BaseModel, Generic[ItemT]):
    """Bounded page returned from an immutable result generation."""

    generation_id: str
    items: list[ItemT]
    next_cursor: str | None = None
    total_count: int | None = Field(default=None, ge=0)


class DurableCheckpoint(BaseModel):
    """Versioned safe boundary for resumable catalog and planning work."""

    model_config = ConfigDict(frozen=True)

    schema_version: Literal[1] = CHECKPOINT_SCHEMA_VERSION
    operation_id: str
    profile_id: str
    profile_schema_version: int = Field(ge=1)
    catalog_schema_version: int = Field(ge=1)
    phase: str
    state: CheckpointState = "active"
    high_water_marks: dict[str, JsonValue] = Field(default_factory=dict)
    algorithm_versions: dict[str, str] = Field(default_factory=dict)
    committed_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))


class ProgressDimension(BaseModel):
    """Honest progress for one unit such as files, bytes, or directories."""

    model_config = ConfigDict(frozen=True)

    unit: Literal["files", "bytes", "directories", "groups", "actions"]
    completed: int = Field(default=0, ge=0)
    total: int | None = Field(default=None, ge=0)


class ScalableProgress(BaseModel):
    """Versioned progress payload shared by future task/API implementations."""

    model_config = ConfigDict(frozen=True)

    mode: ProgressMode
    phase: str
    dimensions: list[ProgressDimension] = Field(default_factory=list)
    heartbeat_at: datetime = Field(default_factory=lambda: datetime.now(timezone.utc))
    throughput_per_second: float | None = Field(default=None, ge=0)
    eta_seconds: float | None = Field(default=None, ge=0)
    eta_confidence: Literal["low", "medium", "high"] | None = None
    checkpoint: DurableCheckpoint | None = None
