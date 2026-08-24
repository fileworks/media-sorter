"""Publishing a converted file without ever being the reason one is lost.

The order here is the whole point, and it is the order
`optimization_execution` already proved:

1. **stage** the candidate in a private directory on the destination
   filesystem, so a half-written or rejected one is never visible;
2. **prove** it (`conversion_guard`) — a candidate that cannot prove itself is
   discarded and the original is kept, which is the pre-existing fail-safe;
3. **declare a durable intent** to move the original, and fsync it;
4. **quarantine the original** into the managed store, where it is recorded and
   restorable, and commit the intent against that record;
5. **promote** the candidate onto the published path with a **no-clobber**
   link/rename, which never replaces a file that appeared in the meantime.

At no point does the only copy of the user's file stop existing. The worst
crash outcome is an original in quarantine with a record, or a pending intent
that `pending_intents()` reports — never a file that is simply gone.
"""

from __future__ import annotations

import contextlib
import errno
import os
import shutil
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from app.core.exceptions import IntegrityTransferError
from app.core.logging_config import get_logger
from app.services.conversion_guard import (
    CandidateProof,
    ConversionCandidateRejected,
    MediaClass,
    validate_converted_image,
    validate_converted_video,
)
from app.services.quarantine import QuarantineError, QuarantineRecord, QuarantineStore
from app.services.verified_transfer import stream_sha256, unlink_revalidated_pair

logger = get_logger(__name__)

_NO_LINK_ERRNOS = frozenset(
    code
    for code in (
        errno.EXDEV,
        errno.EPERM,
        errno.EACCES,
        getattr(errno, "ENOTSUP", None),
        getattr(errno, "EOPNOTSUPP", None),
        getattr(errno, "EMLINK", None),
    )
    if code is not None
)

#: Private, on the destination filesystem so promotion is a same-volume rename,
#: and dot-prefixed so it does not appear in the tree the user browses.
STAGE_DIRECTORY_NAME = ".mediasort-stage"


class ConversionPublicationError(RuntimeError):
    """The original could not be protected, so nothing was published."""


@dataclass(frozen=True)
class ConversionPublication:
    """What happened, in enough detail to journal and to explain."""

    published_path: Path
    converted: bool
    proof: CandidateProof | None = None
    quarantine_record: QuarantineRecord | None = None
    #: Why the original was kept, when it was. `None` when conversion happened.
    kept_original_because: str | None = None


def stage_directory(destination: Path, operation_id: str) -> Path:
    """The private staging directory for one operation, beside *destination*."""
    return destination.parent / STAGE_DIRECTORY_NAME / operation_id


def promote_no_clobber(candidate: Path, target: Path) -> Path:
    """Move *candidate* onto *target*, refusing to replace anything.

    `Path.rename` and `os.replace` both overwrite silently, which is how a file
    that appeared between the precheck and the write gets destroyed. `os.link`
    fails with `FileExistsError` when the target exists, and that failure is the
    guarantee — the link is created or nothing happened.

    Falls back to an exclusive create plus verified copy when the filesystem has
    no hard links (exFAT, some SMB mounts). Candidate removal still goes through
    the final open-handle source/destination identity guard.
    """
    target.parent.mkdir(parents=True, exist_ok=True)
    expected_sha256, expected_size = stream_sha256(candidate)
    try:
        os.link(candidate, target)
    except FileExistsError:
        raise ConversionPublicationError(
            f"refusing to replace an existing file at {target}"
        ) from None
    except OSError as link_error:
        if link_error.errno not in _NO_LINK_ERRNOS:
            raise ConversionPublicationError(
                f"could not publish candidate safely at {target}: {link_error}"
            ) from link_error
        # No hard links here. `O_EXCL` gives the same "create or fail" promise.
        try:
            handle = os.open(target, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o644)
        except FileExistsError:
            raise ConversionPublicationError(
                f"refusing to replace an existing file at {target}"
            ) from None
        try:
            with os.fdopen(handle, "wb") as destination, candidate.open("rb") as source:
                shutil.copyfileobj(source, destination)
                destination.flush()
                os.fsync(destination.fileno())
            unlink_revalidated_pair(
                candidate,
                target,
                expected_sha256=expected_sha256,
                expected_size_bytes=expected_size,
            )
        except (OSError, IntegrityTransferError) as exc:
            raise ConversionPublicationError(
                f"candidate changed or could not be removed after verified publication at {target}"
            ) from exc
        return target
    try:
        unlink_revalidated_pair(
            candidate,
            target,
            expected_sha256=expected_sha256,
            expected_size_bytes=expected_size,
        )
    except (OSError, IntegrityTransferError) as exc:
        raise ConversionPublicationError(
            f"candidate changed or could not be removed after verified publication at {target}"
        ) from exc
    return target


def publish_converted_file(
    original: Path,
    *,
    convert: Callable[[Path], Path],
    expected_suffix: str,
    media: MediaClass,
    quarantine: QuarantineStore,
    operation_id: str,
    final_path: Path | None = None,
) -> ConversionPublication:
    """Convert *original*, and publish the result only if it proves itself.

    *convert* is handed the staging directory's parent problem already solved:
    it receives *original* and must return the candidate it wrote. Returning
    *original* means "nothing to do".
    """
    stage = stage_directory(original, operation_id)
    target = final_path or original.with_suffix(expected_suffix)

    try:
        candidate = convert(original)
    except Exception as exc:
        # Pre-existing fail-safe: a converter that raises leaves the original
        # exactly where it was. Preserved deliberately.
        _clear_stage(stage)
        logger.warning(
            "conversion.failed_keeping_original",
            path=str(original),
            error=f"{type(exc).__name__}: {exc}",
        )
        return ConversionPublication(
            published_path=original,
            converted=False,
            kept_original_because=f"converter raised {type(exc).__name__}",
        )

    if candidate == original:
        _clear_stage(stage)
        return ConversionPublication(published_path=original, converted=False)

    validate = validate_converted_image if media == "image" else validate_converted_video
    try:
        proof = validate(original, candidate, expected_suffix=expected_suffix)
    except ConversionCandidateRejected as rejection:
        # The candidate is the thing that failed, so the candidate is the thing
        # that goes. The original has not been touched.
        candidate.unlink(missing_ok=True)
        _clear_stage(stage)
        logger.warning(
            "conversion.candidate_rejected_keeping_original",
            path=str(original),
            reason=rejection.reason,
        )
        return ConversionPublication(
            published_path=original,
            converted=False,
            kept_original_because=rejection.reason,
        )

    # From here the candidate has earned publication. ``quarantine`` owns the
    # complete durable intent/transfer/record protocol intrinsically; a second
    # caller-managed intent can diverge at the crash boundary.
    try:
        record = quarantine.quarantine(
            original,
            operation_id=operation_id,
            reason="optimization_original",
            keeper_path=target,
            move=True,
            notes=(f"replaced by conversion to {expected_suffix.lstrip('.')}", proof.detail),
        )
    except (OSError, QuarantineError) as exc:
        candidate.unlink(missing_ok=True)
        _clear_stage(stage)
        # A failed quarantine must never be masked into "keeping original and
        # carrying on": the run asked to convert and could not do so safely.
        raise ConversionPublicationError(
            f"could not quarantine the original before publishing: {exc}"
        ) from exc
    try:
        published = promote_no_clobber(candidate, target)
    except ConversionPublicationError:
        # The original is in quarantine with a record, so nothing is lost and
        # the state is recoverable. Say so rather than pretending it published.
        _clear_stage(stage)
        raise

    _clear_stage(stage)
    logger.info(
        "conversion.published",
        path=str(published),
        quarantined=record.quarantine_path,
        proof=proof.detail,
    )
    return ConversionPublication(
        published_path=published,
        converted=True,
        proof=proof,
        quarantine_record=record,
    )


def _clear_stage(stage: Path) -> None:
    """Staging holds nothing worth keeping once the decision is made."""
    with contextlib.suppress(OSError):
        shutil.rmtree(stage, ignore_errors=True)
        # Remove the shared parent too, but only while it is empty — a
        # concurrent operation's directory must survive.
        with contextlib.suppress(OSError):
            stage.parent.rmdir()


def record_conversion(record: dict[str, Any], publication: ConversionPublication) -> None:
    """Carry the conversion's evidence onto the file's report row."""
    if not publication.converted:
        if publication.kept_original_because is not None:
            record["conversion_kept_original_because"] = publication.kept_original_because
        return
    record["conversion_proof"] = None if publication.proof is None else publication.proof.detail
    record["conversion_output_bytes"] = (
        None if publication.proof is None else publication.proof.size_bytes
    )
    if publication.quarantine_record is not None:
        record["conversion_original_quarantine_id"] = publication.quarantine_record.record_id
        record["conversion_original_bytes"] = publication.quarantine_record.size_bytes
