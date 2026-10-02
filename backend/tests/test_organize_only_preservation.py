"""Golden-file proof that default processing never alters media bytes.

Organize Only may rename, route, quarantine, and describe media, but the bytes
that land at the destination must be the bytes that left the source. Each test
compares a full SHA-256 across a scenario the sort pipeline treats differently.
"""

from __future__ import annotations

import hashlib
import os
from datetime import datetime
from pathlib import Path
from typing import Any

import pytest

from app.core.config import Config
from app.core.exceptions import MutationPolicyError
from app.core.integrity import PreservationProfile
from app.core.integrity_policy import authorize_config_mutations
from app.services.duplicate_service import DuplicateRegistry, DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.operation_execution import OperationExecution
from app.services.sorting_service import SortingService

pytestmark = pytest.mark.filterwarnings("ignore::DeprecationWarning")


class _StubConfigService:
    def __init__(self, config: Config) -> None:
        self._config = config

    def get(self) -> Config:
        return self._config


def _service(config: Config) -> SortingService:
    from app.services.conversion_service import ConversionService
    from app.services.repair_service import RepairService

    return SortingService(
        config=config,
        config_service=_StubConfigService(config),  # type: ignore[arg-type]
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
    )


def _config(tmp_path: Path, **overrides: Any) -> Config:
    values: dict[str, Any] = {
        "source_directory": str(tmp_path / "source"),
        "target_directory": str(tmp_path / "sorted"),
        "copy_instead_of_move": True,
        "remove_duplicates": False,
        "repair_enabled": False,
        "convert_images": False,
        "convert_videos": False,
        "override_metadata": False,
        "ai_tagging_enabled": False,
        "embed_tags_in_files": False,
    }
    values.update(overrides)
    return Config(**values)


def _jpeg(path: Path, colour: tuple[int, int, int] = (12, 34, 56)) -> bytes:
    image = pytest.importorskip("PIL.Image")
    piexif = pytest.importorskip("piexif")
    path.parent.mkdir(parents=True, exist_ok=True)
    exif = piexif.dump(
        {"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2021:06:05 10:11:12"}, "0th": {}, "1st": {}}
    )
    image.new("RGB", (24, 24), color=colour).save(path, format="JPEG", exif=exif)
    return path.read_bytes()


def _execution(tmp_path: Path, config: Config) -> OperationExecution:
    return OperationExecution.start(
        operation_id="sort_golden",
        state_root=tmp_path / "state",
        preservation=config.preservation_profile,
        authorization=authorize_config_mutations(config),
        effective_config_sha256=hashlib.sha256(b"config").hexdigest(),
    )


def _process(
    service: SortingService,
    config: Config,
    tmp_path: Path,
    source: Path,
    execution: OperationExecution | None = None,
) -> dict[str, Any]:
    return service._process_file(
        file_path=source,
        source_root=tmp_path / "source",
        dest_root=tmp_path / "sorted",
        config=config,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="sort_golden",
        execution=execution,
    )


# ------------------------------------------------------------------ #
# Byte identity                                                        #
# ------------------------------------------------------------------ #


def test_default_copy_leaves_the_destination_byte_identical(tmp_path: Path) -> None:
    config = _config(tmp_path)
    source = tmp_path / "source" / "holiday.jpg"
    original = _jpeg(source)
    execution = _execution(tmp_path, config)

    record = _process(_service(config), config, tmp_path, source, execution)

    assert record["status"] == "success"
    placed = Path(record["dest_path"])
    assert placed.read_bytes() == original
    assert record["content_sha256"] == hashlib.sha256(original).hexdigest()
    assert source.read_bytes() == original


def test_default_move_leaves_the_destination_byte_identical(tmp_path: Path) -> None:
    config = _config(tmp_path, copy_instead_of_move=False)
    source = tmp_path / "source" / "holiday.jpg"
    original = _jpeg(source)
    execution = _execution(tmp_path, config)

    record = _process(_service(config), config, tmp_path, source, execution)

    assert Path(record["dest_path"]).read_bytes() == original
    assert source.exists() is False


def test_renaming_never_changes_content(tmp_path: Path) -> None:
    config = _config(tmp_path, rename=True, rename_pattern="TYPE_YYYY-MM-DD")
    source = tmp_path / "source" / "IMG_0042.jpg"
    original = _jpeg(source)

    record = _process(_service(config), config, tmp_path, source, _execution(tmp_path, config))

    placed = Path(record["dest_path"])
    assert placed.name != source.name
    assert placed.read_bytes() == original


def test_quarantined_media_is_byte_identical_too(tmp_path: Path) -> None:
    config = _config(tmp_path)
    image = pytest.importorskip("PIL.Image")
    source = tmp_path / "source" / "from-the-future.png"
    source.parent.mkdir(parents=True, exist_ok=True)
    image.new("RGB", (16, 16), color=(9, 9, 9)).save(source, format="PNG")
    original = source.read_bytes()
    future = datetime(2099, 5, 4).timestamp()
    os.utime(source, (future, future))

    record = _process(_service(config), config, tmp_path, source, _execution(tmp_path, config))

    assert record["status"] in {"future_date", "unknown_date"}
    assert Path(record["dest_path"]).read_bytes() == original
    assert source.read_bytes() == original


def test_duplicate_quarantine_is_byte_identical(tmp_path: Path) -> None:
    config = _config(tmp_path, remove_duplicates=True, duplicate_perceptual_enabled=False)
    service = _service(config)
    execution = _execution(tmp_path, config)
    registry = DuplicateRegistry()
    first = tmp_path / "source" / "one.jpg"
    second = tmp_path / "source" / "two.jpg"
    original = _jpeg(first)
    second.write_bytes(original)

    for path in (first, second):
        record = service._process_file(
            file_path=path,
            source_root=tmp_path / "source",
            dest_root=tmp_path / "sorted",
            config=config,
            dry_run=False,
            registry=registry,
            operation_id="sort_golden",
            execution=execution,
        )
        assert Path(record["dest_path"]).read_bytes() == original

    assert record["status"] == "duplicate"


# ------------------------------------------------------------------ #
# Preservation and derived metadata                                    #
# ------------------------------------------------------------------ #


def test_source_timestamps_survive_organization(tmp_path: Path) -> None:
    config = _config(tmp_path)
    source = tmp_path / "source" / "old.jpg"
    _jpeg(source)
    historical = 1_012_345_678
    os.utime(source, (historical, historical))

    record = _process(_service(config), config, tmp_path, source, _execution(tmp_path, config))

    placed = Path(record["dest_path"])
    assert placed.stat().st_mtime_ns == source.stat().st_mtime_ns
    assert record["derived_date_applied"] is False
    assert record["timestamps_requested_ns"] == record["timestamps_observed_ns"]


def test_derived_date_is_applied_only_when_preservation_is_switched_off(tmp_path: Path) -> None:
    config = _config(tmp_path)
    config.preservation_profile = PreservationProfile(preserve_filesystem_timestamps=False)
    source = tmp_path / "source" / "old.jpg"
    _jpeg(source)
    historical = 1_012_345_678
    os.utime(source, (historical, historical))

    record = _process(_service(config), config, tmp_path, source, _execution(tmp_path, config))

    assert record["derived_date_applied"] is True
    assert Path(record["dest_path"]).stat().st_mtime_ns != source.stat().st_mtime_ns


def test_tags_go_to_the_report_instead_of_the_media_bytes(tmp_path: Path) -> None:
    config = _config(tmp_path)
    source = tmp_path / "source" / "tagged.jpg"
    original = _jpeg(source)
    service = _service(config)

    record = service._process_file(
        file_path=source,
        source_root=tmp_path / "source",
        dest_root=tmp_path / "sorted",
        config=config,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="sort_golden",
        execution=_execution(tmp_path, config),
    )
    placed = Path(record["dest_path"])
    written = service._write_derived_tags(
        placed,
        ["beach", "sunset"],
        config=config,
        preservation=config.preservation_profile,
        authorization=authorize_config_mutations(config),
    )

    assert written == "report"
    assert placed.read_bytes() == original
    assert list(placed.parent.glob("*.xmp")) == []


def test_sidecar_profile_writes_beside_the_media_without_touching_it(tmp_path: Path) -> None:
    config = _config(tmp_path)
    config.preservation_profile = PreservationProfile(derived_metadata="sidecar_and_report")
    source = tmp_path / "source" / "tagged.jpg"
    original = _jpeg(source)
    service = _service(config)

    written = service._write_derived_tags(
        source,
        ["beach"],
        config=config,
        preservation=config.preservation_profile,
        authorization=authorize_config_mutations(config),
    )

    assert written == "sidecar"
    assert source.read_bytes() == original
    assert (source.parent / "tagged.jpg.xmp").is_file()


def test_embedding_tags_without_a_reviewed_profile_is_refused(tmp_path: Path) -> None:
    config = _config(tmp_path)
    source = tmp_path / "source" / "tagged.jpg"
    original = _jpeg(source)
    service = _service(config)
    config.embed_tags_in_files = True

    with pytest.raises(MutationPolicyError) as error:
        service._write_derived_tags(
            source,
            ["beach"],
            config=config,
            preservation=config.preservation_profile,
            authorization=authorize_config_mutations(config),
        )

    assert error.value.details["capability"] == "embedded_metadata"
    assert source.read_bytes() == original


# ------------------------------------------------------------------ #
# Integrity reporting                                                  #
# ------------------------------------------------------------------ #


def test_each_action_and_the_aggregate_report_are_auditable(tmp_path: Path) -> None:
    config = _config(tmp_path)
    execution = _execution(tmp_path, config)
    source = tmp_path / "source" / "audit.jpg"
    original = _jpeg(source)

    record = _process(_service(config), config, tmp_path, source, execution)
    path = execution.store_report("completed")

    assert path is not None and path.is_file()
    report = path.read_text(encoding="utf-8")
    assert record["content_sha256"] in report
    assert str(source) in report
    assert '"outcome": "completed"' in report
    assert '"verified_success": 1' in report
    assert execution.bytes_written == len(original)


def test_the_operation_manifest_and_journal_describe_every_placement(tmp_path: Path) -> None:
    from app.core.action_journal import read_journal, read_manifest_actions

    config = _config(tmp_path)
    execution = _execution(tmp_path, config)
    source = tmp_path / "source" / "journalled.jpg"
    _jpeg(source)

    _process(_service(config), config, tmp_path, source, execution)
    execution.finish("completed")

    actions = read_manifest_actions(tmp_path / "state", "sort_golden")
    assert len(actions) == 1
    assert actions[0].effects.content == "unchanged"
    assert actions[0].effects.source == "retained"

    assert execution.journal is not None
    stored = read_journal(execution.journal.path)
    assert stored.state == "completed"
    assert [entry.stage for entry in stored.entries][0] == "planned"
    assert "committed" in [entry.stage for entry in stored.entries]
