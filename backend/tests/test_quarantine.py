"""Quarantine is only useful if every record can still bring its file back."""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.quarantine import QuarantineError, QuarantineStore, store_for_state_root


@pytest.fixture()
def store(tmp_path: Path) -> QuarantineStore:
    return store_for_state_root(tmp_path / "state")


def _file(path: Path, content: bytes = b"original bytes") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(content)
    return path


class TestQuarantine:
    def test_record_describes_a_file_that_exists(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "photo.jpg")

        record = store.quarantine(source, operation_id="op1", reason="duplicate")

        assert not source.exists()
        assert Path(record.quarantine_path).is_file()
        assert record.original_path == str(source)
        assert len(record.sha256) == 64

    def test_copy_mode_leaves_the_source_in_place(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "photo.jpg")

        record = store.quarantine(source, operation_id="op1", reason="duplicate", move=False)

        assert source.is_file()
        assert Path(record.quarantine_path).is_file()

    def test_name_collisions_never_overwrite_an_earlier_original(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        first = store.quarantine(
            _file(tmp_path / "a" / "photo.jpg", b"first"), operation_id="op1", reason="duplicate"
        )
        second = store.quarantine(
            _file(tmp_path / "b" / "photo.jpg", b"second"), operation_id="op1", reason="duplicate"
        )

        assert first.quarantine_path != second.quarantine_path
        assert Path(first.quarantine_path).read_bytes() == b"first"
        assert Path(second.quarantine_path).read_bytes() == b"second"

    def test_keeper_link_survives_a_reload(self, tmp_path: Path, store: QuarantineStore) -> None:
        keeper = _file(tmp_path / "library" / "kept.jpg")
        store.quarantine(
            _file(tmp_path / "library" / "copy.jpg"),
            operation_id="op1",
            reason="duplicate",
            keeper_path=keeper,
        )

        reloaded = QuarantineStore(store.root).records()

        assert reloaded[0].keeper_path == str(keeper)

    def test_damaged_record_line_does_not_hide_the_others(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        store.quarantine(_file(tmp_path / "a.jpg"), operation_id="op1", reason="duplicate")
        with store.records_path.open("a", encoding="utf-8") as handle:
            handle.write('{"record_id": "truncated"\n')
        store.quarantine(_file(tmp_path / "b.jpg"), operation_id="op1", reason="duplicate")

        assert len(store.records()) == 2


class TestRestore:
    def test_preview_reports_the_target_before_anything_moves(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "photo.jpg")
        record = store.quarantine(source, operation_id="op1", reason="duplicate")

        preview = store.preview_restore(record)

        assert preview.restorable
        assert preview.target_path == source
        assert preview.hash_matches is True
        assert not source.exists()  # a preview moves nothing

    def test_restore_returns_the_original_bytes(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "photo.jpg", b"the only copy")
        record = store.quarantine(source, operation_id="op1", reason="optimization_original")

        updated = store.restore(record)

        assert source.read_bytes() == b"the only copy"
        assert updated.retention == "restored"
        assert updated.restored_to == str(source)

    def test_conflicting_target_is_never_overwritten(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "photo.jpg", b"quarantined")
        record = store.quarantine(source, operation_id="op1", reason="duplicate")
        _file(source, b"something else entirely")

        with pytest.raises(QuarantineError):
            store.restore(record)
        assert source.read_bytes() == b"something else entirely"

    def test_alternate_path_resolves_a_conflict_without_loss(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "photo.jpg", b"quarantined")
        record = store.quarantine(source, operation_id="op1", reason="duplicate")
        _file(source, b"newer file")

        updated = store.restore(record, on_conflict="alternate_path")

        assert source.read_bytes() == b"newer file"
        assert Path(updated.restored_to or "").read_bytes() == b"quarantined"

    def test_identical_target_is_treated_as_already_restored(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        source = _file(tmp_path / "library" / "photo.jpg", b"same")
        record = store.quarantine(source, operation_id="op1", reason="duplicate", move=False)

        updated = store.restore(record)

        assert updated.retention == "restored"
        assert source.read_bytes() == b"same"

    def test_tampered_quarantine_file_blocks_the_restore(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        record = store.quarantine(
            _file(tmp_path / "photo.jpg"), operation_id="op1", reason="duplicate"
        )
        Path(record.quarantine_path).write_bytes(b"tampered")

        preview = store.preview_restore(record)

        assert not preview.restorable
        assert preview.hash_matches is False
        with pytest.raises(QuarantineError):
            store.restore(record)

    def test_missing_quarantine_file_blocks_the_restore(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        record = store.quarantine(
            _file(tmp_path / "photo.jpg"), operation_id="op1", reason="duplicate"
        )
        Path(record.quarantine_path).unlink()

        assert store.preview_restore(record).blocked_reason is not None

    def test_restoring_twice_is_refused(self, tmp_path: Path, store: QuarantineStore) -> None:
        source = _file(tmp_path / "library" / "photo.jpg")
        record = store.quarantine(source, operation_id="op1", reason="duplicate")
        updated = store.restore(record)

        with pytest.raises(QuarantineError):
            store.restore(updated)


class TestSummary:
    def test_summary_counts_bytes_and_reasons_without_paths(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        store.quarantine(_file(tmp_path / "a.jpg", b"1234"), operation_id="op", reason="duplicate")
        store.quarantine(_file(tmp_path / "b.jpg", b"12"), operation_id="op", reason="junk")

        summary = store.summary()

        assert summary["retained_count"] == 2
        assert summary["retained_bytes"] == 6
        assert summary["by_reason"] == {"duplicate": 1, "junk": 1}
        assert "original_path" not in summary

    def test_restored_records_leave_the_retained_total(
        self, tmp_path: Path, store: QuarantineStore
    ) -> None:
        record = store.quarantine(
            _file(tmp_path / "lib" / "a.jpg", b"1234"), operation_id="op", reason="duplicate"
        )
        store.restore(record)

        summary = store.summary()

        assert summary["retained_count"] == 0
        assert summary["restored_count"] == 1
