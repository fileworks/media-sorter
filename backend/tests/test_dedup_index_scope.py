"""C-16: one index, several roots, and each refresh authoritative for its own.

`refresh()` ended with an unscoped prune: `DELETE FROM files` for every row not
seen in *this* walk. The sort refreshes the destination and then each reference
library into the same index, so the reference pass deleted the entire
destination — and a file already sitting in the destination stopped being
recognised as a duplicate of the one about to be copied there.

The two refreshes share one index by design. What was missing is that each is
only authoritative about the root it walked.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.dedup_index import DedupIndex
from app.services.duplicate_service import DuplicateService


def _file(path: Path, payload: bytes) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


@pytest.fixture()
def index(tmp_path: Path) -> DedupIndex:
    return DedupIndex(tmp_path / "dedup.sqlite3")


def _refresh(index: DedupIndex, root: Path) -> object:
    return index.refresh(root, DuplicateService(), perceptual=False, sample_video=False)


class TestMultiRootRefresh:
    def test_a_destination_entry_survives_a_reference_refresh(
        self, index: DedupIndex, tmp_path: Path
    ) -> None:
        """The exact sequence `SortingService.run` performs."""
        destination = tmp_path / "destination"
        reference = tmp_path / "reference"
        kept = _file(destination / "2024" / "holiday.jpg", b"the destination copy")
        _file(reference / "unrelated.jpg", b"something else entirely")

        _refresh(index, destination)
        _refresh(index, reference)

        registry = index.load_registry()
        assert registry.exact, "the reference refresh emptied the destination index"
        assert str(kept) in set(registry.exact.values())

    def test_a_reference_entry_survives_a_destination_refresh(
        self, index: DedupIndex, tmp_path: Path
    ) -> None:
        """Symmetric: order must not decide which root survives."""
        destination = tmp_path / "destination"
        reference = tmp_path / "reference"
        _file(destination / "a.jpg", b"destination bytes")
        held = _file(reference / "b.jpg", b"reference bytes")

        _refresh(index, reference)
        _refresh(index, destination)

        assert str(held) in set(index.load_registry().exact.values())

    def test_both_roots_are_present_after_both_refreshes(
        self, index: DedupIndex, tmp_path: Path
    ) -> None:
        destination = tmp_path / "destination"
        reference = tmp_path / "reference"
        first = _file(destination / "a.jpg", b"destination bytes")
        second = _file(reference / "b.jpg", b"reference bytes")

        _refresh(index, destination)
        _refresh(index, reference)

        indexed = set(index.load_registry().exact.values())
        assert {str(first), str(second)} <= indexed


class TestThePruneStillPrunes:
    def test_a_file_removed_from_its_own_root_is_dropped(
        self, index: DedupIndex, tmp_path: Path
    ) -> None:
        """Scoping must not turn the prune off — a stale row is still stale."""
        destination = tmp_path / "destination"
        gone = _file(destination / "gone.jpg", b"deleted later")
        _file(destination / "stays.jpg", b"still here")

        _refresh(index, destination)
        gone.unlink()
        _refresh(index, destination)

        indexed = set(index.load_registry().exact.values())
        assert str(gone) not in indexed
        assert any(path.endswith("stays.jpg") for path in indexed)

    def test_a_nested_root_prunes_only_its_own_subtree(
        self, index: DedupIndex, tmp_path: Path
    ) -> None:
        """A reference inside the destination is a legitimate layout."""
        destination = tmp_path / "library"
        nested = destination / "reference"
        outer = _file(destination / "outer.jpg", b"outer bytes")
        inner = _file(nested / "inner.jpg", b"inner bytes")

        _refresh(index, destination)
        _refresh(index, nested)

        indexed = set(index.load_registry().exact.values())
        assert {str(outer), str(inner)} <= indexed
