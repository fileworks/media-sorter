"""D-09 re-scoped: never skip a file against a keeper nobody re-checked.

`already_in_destination` is a claim about the filesystem *now*, made from an
index built earlier in the same run. If the keeper was deleted or rewritten in
between, the source was skipped anyway — so the file never arrived in the
destination, and the report said it had already been handled.

This is not the data-loss path an earlier draft called it: the source is left
where it is. It is quieter than that and, in its way, harder to notice — a file
that silently never gets organised, with a report claiming success.

I-02 applies: a cached hash is a candidate hint, never proof. The keeper is
re-read here rather than trusted.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.services.duplicate_service import destination_keeper_still_holds
from app.services.verified_transfer import stream_sha256


def _file(path: Path, payload: bytes = b"the destination copy") -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_bytes(payload)
    return path


def _digest(path: Path) -> str:
    return stream_sha256(path)[0]


class TestTheKeeperIsReReadRatherThanTrusted:
    def test_an_unchanged_keeper_verifies(self, tmp_path: Path) -> None:
        keeper = _file(tmp_path / "destination" / "photo.jpg")

        assert destination_keeper_still_holds(keeper, _digest(keeper))

    def test_a_deleted_keeper_does_not_verify(self, tmp_path: Path) -> None:
        """The plain case: the index says it is there and it is not."""
        keeper = _file(tmp_path / "destination" / "photo.jpg")
        expected = _digest(keeper)
        keeper.unlink()

        assert not destination_keeper_still_holds(keeper, expected)

    def test_an_altered_keeper_does_not_verify(self, tmp_path: Path) -> None:
        """Same path, different bytes — which size and mtime can both miss."""
        keeper = _file(tmp_path / "destination" / "photo.jpg")
        expected = _digest(keeper)
        keeper.write_bytes(b"the destination copy, edited!")

        assert not destination_keeper_still_holds(keeper, expected)

    def test_a_same_length_rewrite_does_not_verify(self, tmp_path: Path) -> None:
        """The case a size check would pass and a hash will not."""
        keeper = _file(tmp_path / "destination" / "photo.jpg", b"AAAAAAAAAAAAAAAA")
        expected = _digest(keeper)
        keeper.write_bytes(b"BBBBBBBBBBBBBBBB")

        assert keeper.stat().st_size == 16
        assert not destination_keeper_still_holds(keeper, expected)

    def test_a_symlink_in_place_of_the_keeper_does_not_verify(self, tmp_path: Path) -> None:
        real = _file(tmp_path / "elsewhere" / "photo.jpg")
        keeper = tmp_path / "destination" / "photo.jpg"
        keeper.parent.mkdir(parents=True)
        keeper.symlink_to(real)

        assert not destination_keeper_still_holds(keeper, _digest(real))

    def test_a_directory_in_place_of_the_keeper_does_not_verify(self, tmp_path: Path) -> None:
        keeper = tmp_path / "destination" / "photo.jpg"
        keeper.mkdir(parents=True)

        assert not destination_keeper_still_holds(keeper, "0" * 64)


class TestUncertaintyIsNeverTreatedAsVerified:
    @pytest.mark.parametrize("expected", [None, ""])
    def test_no_recorded_digest_means_no_verification(
        self, tmp_path: Path, expected: str | None
    ) -> None:
        """Nothing to compare against is not the same as a match.

        A wrong `False` sorts the file normally, which is what the user asked
        for. A wrong `True` is a file that never arrives.
        """
        keeper = _file(tmp_path / "destination" / "photo.jpg")

        assert not destination_keeper_still_holds(keeper, expected)

    def test_an_absent_parent_directory_does_not_verify(self, tmp_path: Path) -> None:
        assert not destination_keeper_still_holds(tmp_path / "gone" / "photo.jpg", "0" * 64)


def test_the_skip_consults_the_check_before_reporting() -> None:
    """The ordering is the fix: the status must not be set on an unchecked keeper."""
    source = Path(__file__).resolve().parents[1] / "app" / "services" / "sorting_service.py"
    body = source.read_text(encoding="utf-8")

    branch = body.index('if match.scope == "destination":')
    guard = body.index("destination_keeper_still_holds(", branch)
    status = body.index('status="already_in_destination"', branch)

    assert guard < status, "the skip is reported before the keeper is verified"


@pytest.mark.parametrize(
    "sabotage",
    ["deleted", "rewritten"],
    ids=["keeper deleted after indexing", "keeper rewritten after indexing"],
)
def test_a_stale_destination_keeper_no_longer_skips_the_file(tmp_path: Path, sabotage: str) -> None:
    """End to end, through the real sort path.

    Before the fix this reported `already_in_destination` and returned no
    destination, so the source stayed where it was and the run claimed it had
    been handled. This is the assertion that changes behaviour rather than the
    helper's own unit tests, which a fresh module would pass by construction.
    """
    from datetime import date
    from unittest.mock import patch

    from app.core.config import Config
    from app.services.config_service import ConfigService
    from app.services.conversion_service import ConversionService
    from app.services.duplicate_service import DuplicateRegistry, DuplicateService
    from app.services.extraction_service import DateExtractionService, ExtractionResult
    from app.services.filesystem_service import FileSystemService
    from app.services.metadata_service import MetadataService
    from app.services.repair_service import RepairService
    from app.services.sorting_service import SortingService

    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir()
    dest_root.mkdir()

    payload = b"\xff\xd8\xff\xe0the one true photo"
    incoming = source_root / "photo.jpg"
    incoming.write_bytes(payload)
    keeper = dest_root / "2024" / "01" / "01" / "photo.jpg"
    _file(keeper, payload)

    # The destination index as it stood when the run began.
    dest_registry = DuplicateRegistry(exact={_digest(keeper): str(keeper)})

    if sabotage == "deleted":
        keeper.unlink()
    else:
        keeper.write_bytes(b"\xff\xd8\xff\xe0someone edited this afterwards")

    config = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        copy_instead_of_move=True,
        remove_duplicates=True,
        duplicate_exact_enabled=True,
        duplicate_perceptual_enabled=False,
    )
    service = SortingService(
        config=config,
        config_service=ConfigService(config),
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
        db_manager=None,
    )

    with patch.object(
        service._extraction,
        "extract_detailed",
        return_value=ExtractionResult(extracted_date=date(2024, 1, 1), source="exif"),
    ):
        record = service._process_file(
            file_path=incoming,
            source_root=source_root,
            dest_root=dest_root,
            config=config,
            dry_run=True,
            registry=DuplicateRegistry(),
            operation_id="op_stale_keeper",
            dest_registry=dest_registry,
        )

    assert record["status"] != "already_in_destination", (
        "the file was skipped against a keeper that no longer holds those bytes"
    )
