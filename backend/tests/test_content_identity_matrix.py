from __future__ import annotations

import os
from pathlib import Path

import pytest

from app.core.catalog_schema import fingerprint
from app.core.exceptions import IntegrityTransferError
from app.services.catalog import bounded_sample_sha256
from app.services.verified_transfer import revalidate_sha256


@pytest.mark.parametrize(
    ("platform", "before", "after"),
    [
        (
            "linux",
            {"ctime_ns": 10, "file_identity": "42", "sample_sha256": None},
            {"ctime_ns": 11, "file_identity": "42", "sample_sha256": None},
        ),
        (
            "darwin",
            {"ctime_ns": 10, "file_identity": "42", "sample_sha256": None},
            {"ctime_ns": 11, "file_identity": "42", "sample_sha256": None},
        ),
        (
            "win32",
            {"ctime_ns": 10, "file_identity": "42", "sample_sha256": "a" * 64},
            {"ctime_ns": 10, "file_identity": "42", "sample_sha256": "b" * 64},
        ),
    ],
)
def test_same_size_preserved_mtime_rewrite_invalidates_platform_hint(
    platform: str,
    before: dict[str, int | str | None],
    after: dict[str, int | str | None],
) -> None:
    common = {"size_bytes": 4096, "mtime_ns": 123}
    # The keys are the matrix dimension under test, so both calls are dynamic.
    left = fingerprint(**common, **before)  # type: ignore[arg-type]
    right = fingerprint(**common, **after)  # type: ignore[arg-type]
    assert left != right, platform


def test_replace_and_rename_identity_changes_invalidate_the_hint() -> None:
    before = fingerprint(size_bytes=1, mtime_ns=2, ctime_ns=3, file_identity="old")
    after = fingerprint(size_bytes=1, mtime_ns=2, ctime_ns=3, file_identity="replacement")
    assert before != after


def test_bounded_sample_is_a_safe_weak_metadata_fallback(tmp_path: Path) -> None:
    path = tmp_path / "network-volume.bin"
    path.write_bytes(b"a" * 20_000)
    before = bounded_sample_sha256(path)
    original = path.stat()
    path.write_bytes(b"b" + b"a" * 19_998 + b"c")
    os.utime(path, ns=(original.st_atime_ns, original.st_mtime_ns))

    assert bounded_sample_sha256(path) != before


def test_destructive_proof_rejects_symlinks_and_inaccessible_files(tmp_path: Path) -> None:
    target = tmp_path / "target.bin"
    target.write_bytes(b"content")
    link = tmp_path / "link.bin"
    try:
        link.symlink_to(target)
    except OSError:
        pytest.skip("symlinks are unavailable on this runner")

    with pytest.raises((IntegrityTransferError, OSError)):
        revalidate_sha256(link)
    with pytest.raises((IntegrityTransferError, OSError)):
        revalidate_sha256(tmp_path / "missing.bin")


def test_full_hash_progress_is_bounded_by_chunks_and_finishes_exactly(
    tmp_path: Path,
) -> None:
    source = tmp_path / "large.bin"
    source.write_bytes(b"x" * (3 * 1024 * 1024 + 17))
    progress: list[tuple[int, int]] = []

    _digest, size = revalidate_sha256(
        source,
        on_progress=lambda done, total: progress.append((done, total)),
    )

    assert size == source.stat().st_size
    assert progress[-1] == (size, size)
    assert len(progress) == 4
