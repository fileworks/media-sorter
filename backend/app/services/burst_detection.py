"""Review-first image burst detection and measurable sharpness ranking."""

from __future__ import annotations

import csv
import fnmatch
import hashlib
import io
import os
import unicodedata
import uuid
from collections.abc import Sequence
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path
from typing import Literal

from pydantic import BaseModel, ConfigDict, Field

from app.core.duplicate_plans import DuplicateGroup, GroupMember
from app.core.media_units import MediaUnit, bind_media_units
from app.services.duplicate_service import DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import open_image
from app.services.quarantine import QuarantineRecord, QuarantineStore
from app.services.signature_extraction import capture_time
from app.services.verified_transfer import stream_sha256
from app.utils.media_utils import is_image


class BurstFrame(BaseModel):
    model_config = ConfigDict(frozen=True)

    frame_id: str
    unit_id: str
    primary_path: str
    member_paths: tuple[str, ...]
    member_fingerprints: tuple[str, ...]
    captured_at: datetime
    camera_identity: str
    perceptual_distance_from_previous: int | None = Field(default=None, ge=0)
    sharpness: float | None = Field(default=None, ge=0)


class BurstGroup(BaseModel):
    model_config = ConfigDict(frozen=True)

    group_id: str
    frames: tuple[BurstFrame, ...] = Field(min_length=2)
    proposed_representative_id: str
    reviewed: bool = False
    dismissed: bool = False
    kept_frame_ids: tuple[str, ...] = ()


class BurstQuarantineMember(BaseModel):
    model_config = ConfigDict(frozen=True)

    frame_id: str
    unit_id: str
    path: str
    fingerprint: str


class BurstQuarantinePlan(BaseModel):
    """Immutable, reviewed actions consumed by the verified quarantine path."""

    model_config = ConfigDict(frozen=True)

    plan_id: str
    group_id: str
    kept_frame_ids: tuple[str, ...]
    members: tuple[BurstQuarantineMember, ...]
    authority_fingerprint: str = ""

    @property
    def bytes_affected(self) -> int:
        return sum(Path(member.path).stat().st_size for member in self.members)


class BurstRunItem(BaseModel):
    model_config = ConfigDict(frozen=True)

    frame_id: str
    unit_id: str
    original_path: str
    quarantine_path: str
    size_bytes: int = Field(ge=0)


class BurstRunReport(BaseModel):
    """Durable report for one confirmed burst-quarantine execution."""

    model_config = ConfigDict(frozen=True)

    operation_id: str
    plan_id: str
    group_id: str
    completed_at: datetime
    kept_frame_ids: tuple[str, ...]
    quarantined: tuple[BurstRunItem, ...]


BURST_REPORTS_DIRECTORY = "burst-reports"


@dataclass(frozen=True)
class BurstSettings:
    enabled: bool = False
    time_window_seconds: float = 3.0
    max_perceptual_distance: int = 4
    require_camera_identity: bool = True


@dataclass
class _Candidate:
    unit: MediaUnit
    captured_at: datetime
    camera: str
    digest: str
    size_bytes: int
    signature: object | None = None
    distance: int | None = None


class BurstDetectionService:
    """Detect only when time, visual signature, and camera all agree."""

    def __init__(self) -> None:
        self.duplicate_service = DuplicateService()
        self.extraction = DateExtractionService()
        self.sharpness_computations = 0
        self._issued_groups: dict[str, BurstGroup] = {}

    def issued_group(self, group_id: str) -> BurstGroup | None:
        """Return only a group this server instance actually detected."""
        return self._issued_groups.get(group_id)

    def issue_review_group(self, group: DuplicateGroup) -> BurstGroup:
        """Authorize a catalog-backed Review burst for the legacy executor.

        ``GET /review/groups`` is the production burst producer. The legacy
        quarantine endpoint therefore receives paths and byte identities only
        through this conversion of the exact server-issued page, never from a
        client request. Media-unit companions are rediscovered beside each
        catalog member and frozen into the issued frame as well.
        """
        if group.kind != "burst" or len(group.members) < 2:
            raise ValueError("only a loaded catalog burst can be issued")
        frames = tuple(self._frame_from_review_member(member) for member in group.members)
        frame_ids = {frame.frame_id for frame in frames}
        representative = (
            group.anchor_member_id if group.anchor_member_id in frame_ids else frames[0].frame_id
        )
        issued = BurstGroup(
            group_id=group.group_id,
            frames=frames,
            proposed_representative_id=representative,
        )
        self._issued_groups[group.group_id] = issued
        return issued

    def _frame_from_review_member(self, member: GroupMember) -> BurstFrame:
        primary = Path(member.observed_path)
        captured = _fact_datetime(member.facts.captured_at.value)
        if captured is None:
            raise ValueError("catalog burst member has no valid capture time")
        unit = _media_unit_beside(primary)
        paths = tuple(item.path for item in unit.members)
        return BurstFrame(
            frame_id=member.member_id,
            unit_id=unit.unit_id,
            primary_path=str(primary),
            member_paths=tuple(str(path) for path in paths),
            member_fingerprints=tuple(_fingerprint(path) for path in paths),
            captured_at=captured,
            camera_identity=self.extraction.extract_camera_model(primary) or "",
            perceptual_distance_from_previous=member.evidence.distance,
        )

    def detect(
        self,
        paths: list[Path],
        root: Path,
        settings: BurstSettings,
    ) -> tuple[BurstGroup, ...]:
        self.sharpness_computations = 0
        if not settings.enabled:
            return ()
        units, _unmatched = bind_media_units(paths, root)
        seen_hashes: set[str] = set()
        candidates: list[_Candidate] = []
        for unit in units:
            if not is_image(unit.primary):
                continue
            captured = _capture_time(unit.primary)
            camera = self.extraction.extract_camera_model(unit.primary) or ""
            if captured is None or (settings.require_camera_identity and not camera):
                continue
            digest, size_bytes = stream_sha256(unit.primary)
            # Exact duplicates take precedence and do not enter burst grouping.
            if digest in seen_hashes:
                continue
            seen_hashes.add(digest)
            candidates.append(_Candidate(unit, captured, camera, digest, size_bytes))
        candidates.sort(key=lambda item: (item.captured_at, str(item.unit.primary)))

        raw_groups: list[list[_Candidate]] = []
        current: list[_Candidate] = []
        for candidate in candidates:
            if not current:
                current = [candidate]
                continue
            previous = current[-1]
            seconds = (candidate.captured_at - previous.captured_at).total_seconds()
            same_camera = candidate.camera == previous.camera
            if seconds < 0 or seconds > settings.time_window_seconds or not same_camera:
                if len(current) > 1:
                    raw_groups.append(current)
                current = [candidate]
                continue
            previous.signature = previous.signature or self.duplicate_service.image_signature(
                previous.unit.primary
            )
            candidate.signature = self.duplicate_service.image_signature(candidate.unit.primary)
            if previous.signature is None or candidate.signature is None:
                if len(current) > 1:
                    raw_groups.append(current)
                current = [candidate]
                continue
            distance = int(previous.signature.phash - candidate.signature.phash)  # type: ignore[attr-defined]
            if distance > settings.max_perceptual_distance:
                if len(current) > 1:
                    raw_groups.append(current)
                current = [candidate]
                continue
            candidate.distance = distance
            current.append(candidate)
        if len(current) > 1:
            raw_groups.append(current)
        groups = tuple(self._rank(group) for group in raw_groups)
        self._issued_groups.update({group.group_id: group for group in groups})
        return groups

    def _rank(self, candidates: list[_Candidate]) -> BurstGroup:
        frames: list[BurstFrame] = []
        for candidate in candidates:
            sharpness = _sharpness(candidate.unit.primary)
            self.sharpness_computations += 1
            identity = hashlib.sha256(str(candidate.unit.primary).encode()).hexdigest()[:16]
            frame_id = f"frame_{identity}"
            frames.append(
                BurstFrame(
                    frame_id=frame_id,
                    unit_id=candidate.unit.unit_id,
                    primary_path=str(candidate.unit.primary),
                    member_paths=tuple(str(item.path) for item in candidate.unit.members),
                    member_fingerprints=tuple(
                        f"sha256:{candidate.digest}:{candidate.size_bytes}"
                        if item.path == candidate.unit.primary
                        else _fingerprint(item.path)
                        for item in candidate.unit.members
                    ),
                    captured_at=candidate.captured_at,
                    camera_identity=candidate.camera,
                    perceptual_distance_from_previous=candidate.distance,
                    sharpness=sharpness,
                )
            )
        ranked = sorted(
            frames,
            key=lambda frame: (
                frame.sharpness is None,
                -(frame.sharpness or 0),
                frame.primary_path,
            ),
        )
        return BurstGroup(
            group_id=f"burst_{uuid.uuid4().hex[:16]}",
            frames=tuple(frames),
            proposed_representative_id=ranked[0].frame_id,
        )


def review_burst(
    group: BurstGroup,
    *,
    keep_frame_ids: tuple[str, ...],
    dismissed: bool = False,
) -> BurstGroup:
    """Freeze an explicit human decision; an unreviewed group has no actions."""
    valid = {frame.frame_id for frame in group.frames}
    if dismissed:
        return group.model_copy(
            update={
                "reviewed": True,
                "dismissed": True,
                "kept_frame_ids": tuple(valid),
            }
        )
    selected = tuple(dict.fromkeys(keep_frame_ids))
    if not selected or not set(selected).issubset(valid):
        raise ValueError("at least one valid burst frame must be kept")
    return group.model_copy(
        update={"reviewed": True, "dismissed": False, "kept_frame_ids": selected}
    )


def quarantine_candidates(group: BurstGroup) -> tuple[BurstFrame, ...]:
    """Return whole media units only after review; never delete anything."""
    if not group.reviewed:
        raise ValueError("burst decisions cannot execute before review")
    if group.dismissed:
        return ()
    keep = set(group.kept_frame_ids)
    return tuple(frame for frame in group.frames if frame.frame_id not in keep)


def plan_burst_quarantine(
    group: BurstGroup,
    *,
    allowed_roots: Sequence[Path] = (),
    protected_roots: Sequence[Path] = (),
    excluded_roots: Sequence[Path] = (),
    exclude_patterns: Sequence[str] = (),
) -> BurstQuarantinePlan:
    """Freeze every member of each non-selected media unit before execution."""
    if not allowed_roots:
        raise ValueError("burst planning requires current mutable root authority")
    candidates = quarantine_candidates(group)
    authority = _authority_fingerprint(
        allowed_roots, protected_roots, excluded_roots, exclude_patterns
    )
    members: list[BurstQuarantineMember] = []
    for frame in candidates:
        if len(frame.member_paths) != len(frame.member_fingerprints):
            raise ValueError("burst group lacks complete server-issued member identity")
        for raw_path, issued_fingerprint in zip(
            frame.member_paths, frame.member_fingerprints, strict=True
        ):
            path = Path(raw_path)
            _assert_burst_scope(
                path,
                allowed_roots,
                protected_roots,
                excluded_roots,
                exclude_patterns,
            )
            if _fingerprint(path) != issued_fingerprint:
                raise ValueError("burst member changed after detection; detect the group again")
            members.append(
                BurstQuarantineMember(
                    frame_id=frame.frame_id,
                    unit_id=frame.unit_id,
                    path=str(path),
                    fingerprint=issued_fingerprint,
                )
            )
    return BurstQuarantinePlan(
        plan_id=f"burst_plan_{uuid.uuid4().hex[:16]}",
        group_id=group.group_id,
        kept_frame_ids=group.kept_frame_ids,
        members=tuple(members),
        authority_fingerprint=authority,
    )


def execute_burst_quarantine(
    plan: BurstQuarantinePlan,
    store: QuarantineStore,
    *,
    operation_id: str,
    allowed_roots: Sequence[Path] = (),
    protected_roots: Sequence[Path] = (),
    excluded_roots: Sequence[Path] = (),
    exclude_patterns: Sequence[str] = (),
) -> tuple[QuarantineRecord, ...]:
    """Execute only the frozen plan; every transfer is verified and recoverable."""
    records: list[QuarantineRecord] = []
    if not allowed_roots or not plan.authority_fingerprint:
        raise ValueError("burst execution requires current mutable root authority")
    current_authority = _authority_fingerprint(
        allowed_roots, protected_roots, excluded_roots, exclude_patterns
    )
    if plan.authority_fingerprint != current_authority:
        raise ValueError("burst authority changed after review; review the group again")
    # Validate the complete frozen unit before moving its first member. A
    # primary and its companions are one reviewed action; discovering drift in
    # a later sidecar after an earlier primary moved would otherwise strand a
    # partially quarantined plan.
    validated: list[tuple[BurstQuarantineMember, Path, str, int]] = []
    for member in plan.members:
        source = Path(member.path)
        _assert_burst_scope(
            source,
            allowed_roots,
            protected_roots,
            excluded_roots,
            exclude_patterns,
        )
        if _fingerprint(source) != member.fingerprint:
            raise ValueError("burst member changed after review; review the group again")
        digest, size_bytes = _fingerprint_identity(member.fingerprint)
        validated.append((member, source, digest, size_bytes))

    for member, source, digest, size_bytes in validated:
        records.append(
            store.quarantine(
                source,
                operation_id=operation_id,
                reason="user_request",
                move=True,
                known_sha256=digest,
                known_size_bytes=size_bytes,
                notes=(
                    f"burst_group={plan.group_id}",
                    f"burst_frame={member.frame_id}",
                    f"media_unit={member.unit_id}",
                ),
            )
        )
    return tuple(records)


def _authority_fingerprint(
    allowed_roots: Sequence[Path],
    protected_roots: Sequence[Path],
    excluded_roots: Sequence[Path] = (),
    exclude_patterns: Sequence[str] = (),
) -> str:
    payload = "|".join(
        [
            "allowed="
            + ",".join(sorted(str(path.resolve(strict=False)) for path in allowed_roots)),
            "protected="
            + ",".join(sorted(str(path.resolve(strict=False)) for path in protected_roots)),
            "excluded="
            + ",".join(sorted(str(path.resolve(strict=False)) for path in excluded_roots)),
            "patterns=" + ",".join(sorted(exclude_patterns)),
        ]
    )
    return hashlib.sha256(payload.encode("utf-8")).hexdigest()


def _assert_burst_scope(
    path: Path,
    allowed_roots: Sequence[Path],
    protected_roots: Sequence[Path],
    excluded_roots: Sequence[Path] = (),
    exclude_patterns: Sequence[str] = (),
) -> None:
    try:
        resolved = path.resolve(strict=True)
    except OSError as exc:
        raise ValueError("burst member is unavailable; review the group again") from exc
    matching_roots = tuple(
        root.resolve(strict=False)
        for root in allowed_roots
        if resolved == root.resolve(strict=False) or root.resolve(strict=False) in resolved.parents
    )
    allowed = bool(matching_roots)
    protected = any(
        resolved == root.resolve(strict=False) or root.resolve(strict=False) in resolved.parents
        for root in protected_roots
    )
    excluded = any(
        resolved == root.resolve(strict=False) or root.resolve(strict=False) in resolved.parents
        for root in excluded_roots
    )
    pattern_excluded = any(
        fnmatch.fnmatch(part, pattern)
        for root in matching_roots
        for part in resolved.relative_to(root).parts
        for pattern in exclude_patterns
    )
    if not allowed or protected or excluded or pattern_excluded:
        raise ValueError("burst member is outside the active mutable roots")


def build_burst_report(
    plan: BurstQuarantinePlan,
    records: tuple[QuarantineRecord, ...],
    *,
    operation_id: str,
) -> BurstRunReport:
    """Pair frozen plan members with verified quarantine outcomes."""
    if len(records) != len(plan.members):
        raise ValueError("burst execution result does not match its frozen plan")
    return BurstRunReport(
        operation_id=operation_id,
        plan_id=plan.plan_id,
        group_id=plan.group_id,
        completed_at=datetime.now(timezone.utc),
        kept_frame_ids=plan.kept_frame_ids,
        quarantined=tuple(
            BurstRunItem(
                frame_id=member.frame_id,
                unit_id=member.unit_id,
                original_path=record.original_path,
                quarantine_path=record.quarantine_path,
                size_bytes=record.size_bytes,
            )
            for member, record in zip(plan.members, records, strict=True)
        ),
    )


def save_burst_report(report: BurstRunReport, state_root: Path) -> Path:
    """Atomically retain the report so history/export survives a restart."""
    directory = state_root / BURST_REPORTS_DIRECTORY
    directory.mkdir(parents=True, exist_ok=True)
    destination = directory / f"{report.operation_id}.json"
    temporary = destination.with_suffix(".json.tmp")
    temporary.write_text(report.model_dump_json(indent=2), encoding="utf-8")
    os.replace(temporary, destination)
    return destination


def load_burst_report(operation_id: str, state_root: Path) -> BurstRunReport | None:
    path = state_root / BURST_REPORTS_DIRECTORY / f"{operation_id}.json"
    if not path.is_file():
        return None
    return BurstRunReport.model_validate_json(path.read_text(encoding="utf-8"))


def export_burst_report(
    report: BurstRunReport,
    format: Literal["json", "csv"],
) -> str:
    if format == "json":
        return report.model_dump_json(indent=2)
    output = io.StringIO()
    writer = csv.DictWriter(
        output,
        fieldnames=(
            "operation_id",
            "plan_id",
            "group_id",
            "frame_id",
            "unit_id",
            "original_path",
            "quarantine_path",
            "size_bytes",
        ),
    )
    writer.writeheader()
    for item in report.quarantined:
        writer.writerow(
            {
                "operation_id": report.operation_id,
                "plan_id": report.plan_id,
                "group_id": report.group_id,
                **item.model_dump(mode="json"),
            }
        )
    return output.getvalue()


def _fact_datetime(value: object) -> datetime | None:
    if isinstance(value, datetime):
        return value
    if not isinstance(value, str) or not value:
        return None
    try:
        return datetime.fromisoformat(value)
    except ValueError:
        return None


def _media_unit_beside(primary: Path) -> MediaUnit:
    """Resolve one server-observed primary and its same-stem companions."""
    normalized_stem = unicodedata.normalize("NFC", primary.stem).casefold()
    candidates: list[Path] = []
    for sibling in primary.parent.iterdir():
        if (
            unicodedata.normalize("NFC", sibling.stem).casefold() == normalized_stem
            and sibling.is_file()
            and not sibling.is_symlink()
        ):
            candidates.append(sibling)
    units, _unmatched = bind_media_units(candidates, primary.parent)
    for unit in units:
        if any(member.path == primary for member in unit.members):
            return unit
    raise ValueError("catalog burst member no longer belongs to an observable media unit")


def _fingerprint(path: Path) -> str:
    digest, size = stream_sha256(path)
    return f"sha256:{digest}:{size}"


def _fingerprint_identity(fingerprint: str) -> tuple[str, int]:
    try:
        prefix, digest, raw_size = fingerprint.split(":", 2)
        size = int(raw_size)
    except (TypeError, ValueError) as exc:
        raise ValueError("burst group has an invalid server-issued member identity") from exc
    if (
        prefix != "sha256"
        or len(digest) != 64
        or any(character not in "0123456789abcdef" for character in digest)
    ):
        raise ValueError("burst group has an invalid server-issued member identity")
    if size < 0:
        raise ValueError("burst group has an invalid server-issued member identity")
    return digest, size


def _capture_time(path: Path) -> datetime | None:
    """Delegates to the pure extractor so there is one definition of this."""
    return capture_time(path)


def _sharpness(path: Path) -> float | None:
    try:
        import numpy as np

        with open_image(path) as image:
            if image is None:
                return None
            gray = np.asarray(image.convert("L").resize((256, 256)), dtype=np.float32)
        center = gray[1:-1, 1:-1]
        laplacian = gray[:-2, 1:-1] + gray[2:, 1:-1] + gray[1:-1, :-2] + gray[1:-1, 2:] - 4 * center
        return float(laplacian.var())
    except Exception:
        return None
