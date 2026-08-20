"""C-10 / I-10: a size nobody could read is not the number zero.

`_safe_stat` returned `0` for any `OSError`, so a file whose size could not be
read was recorded as `0` bytes — indistinguishable from a genuinely empty file.
All three of its call sites build records for *unmatched, failed or corrupted*
files, which is exactly where an unreadable file is most likely to turn up.

I-10 says unknown metadata must stay distinguishable from zero. `None` says
"nobody knows"; `0` says "measured, and it was empty". A report that cannot tell
those apart understates the bytes at stake in a destructive preflight, and
nothing in it says so.

The size the run *does* know is still an `int` — the point is to keep the two
answers separable, not to make every size optional.
"""

from __future__ import annotations

import asyncio
import os
from pathlib import Path
from typing import Any, cast

import pytest
from PIL import Image

from app.background_tasks.task_manager import Task
from app.core.config import Config
from app.services.config_service import ConfigService
from app.services.conversion_service import ConversionService
from app.services.duplicate_service import DuplicateService
from app.services.extraction_service import DateExtractionService
from app.services.filesystem_service import FileSystemService
from app.services.metadata_service import MetadataService
from app.services.repair_service import RepairService
from app.services.sorting_service import SortingService
from app.services.sorting_support import SortingSupportMixin

_safe_stat = SortingSupportMixin._safe_stat


def _photo(path: Path, seed: int = 1) -> Path:
    import random

    rng = random.Random(seed)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = bytes(rng.randrange(256) for _ in range(32 * 32 * 3))
    Image.frombytes("RGB", (32, 32), raw).save(path, quality=95)
    return path


class TestSafeStatSeparatesUnknownFromEmpty:
    """The unit-level invariant, on the three ways a stat actually fails."""

    def test_a_genuinely_empty_file_is_zero(self, tmp_path: Path) -> None:
        empty = tmp_path / "empty.jpg"
        empty.touch()

        assert _safe_stat(empty) == 0

    def test_a_missing_file_is_unknown(self, tmp_path: Path) -> None:
        assert _safe_stat(tmp_path / "never-existed.jpg") is None

    def test_a_dangling_symlink_is_unknown(self, tmp_path: Path) -> None:
        dangling = tmp_path / "dangling.jpg"
        dangling.symlink_to(tmp_path / "no_such_target.jpg")

        assert _safe_stat(dangling) is None

    def test_a_real_file_behind_an_unreadable_directory_is_unknown(self, tmp_path: Path) -> None:
        """The case that loses the most information: a large file reported as 0."""
        locked = tmp_path / "locked"
        locked.mkdir()
        hidden = locked / "real.jpg"
        hidden.write_bytes(b"x" * 1234)
        os.chmod(locked, 0o000)

        try:
            assert _safe_stat(hidden) is None
        finally:
            os.chmod(locked, 0o700)

    def test_unknown_and_empty_are_not_equal(self, tmp_path: Path) -> None:
        """The whole point, stated as one assertion.

        `None == 0` is False in Python, but `not None` and `not 0` are both
        True — so any caller that tests truthiness collapses them again. This
        asserts the values, which is the part `_safe_stat` controls.
        """
        empty = tmp_path / "empty.jpg"
        empty.touch()

        assert _safe_stat(empty) != _safe_stat(tmp_path / "gone.jpg")


class TestUnknownSizeCount:
    """The tally that makes an unreadable file visible in the run's own stats."""

    def test_records_with_no_size_are_counted(self) -> None:
        records: list[dict[str, Any]] = [
            {"file_size": 10},
            {"file_size": None},
            {"file_size": 0},
            {"file_size": None},
        ]

        assert SortingSupportMixin._unknown_size_count(records) == 2

    def test_a_genuinely_empty_file_is_not_counted_as_unknown(self) -> None:
        """`0` is an answer. Counting it here would re-create the bug one level up."""
        assert SortingSupportMixin._unknown_size_count([{"file_size": 0}]) == 0


class _Task:
    """The task protocol the engine uses, with a hook on `checkpoint`."""

    class _Progress:
        def __init__(self) -> None:
            self.current = 0
            self.total = 0
            self.percentage = 0.0
            self.estimated_time_remaining_seconds: float | None = None
            self.phase = ""
            self.outcomes: dict[str, int] = {}
            self.last_checkpoint_label = ""

    def __init__(self, on_checkpoint: Any = None) -> None:
        self.progress = self._Progress()
        self.cancel_event = asyncio.Event()
        self._on_checkpoint = on_checkpoint

    def checkpoint(self, label: str) -> None:
        self.progress.last_checkpoint_label = label
        if self._on_checkpoint is not None:
            self._on_checkpoint()

    def record_outcome(self, code: str, *, count: int = 1) -> None:
        self.progress.outcomes[code] = self.progress.outcomes.get(code, 0) + count

    def transition(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass

    def update_progress(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass

    def mark_partial(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass

    def add_event(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass


def _config(tmp_path: Path) -> Config:
    (tmp_path / "source").mkdir(exist_ok=True)
    (tmp_path / "target").mkdir(exist_ok=True)
    return Config(
        source_directory=str(tmp_path / "source"),
        target_directory=str(tmp_path / "target"),
        sort_criteria=["year"],
        copy_instead_of_move=True,
        remove_duplicates=False,
        repair_enabled=False,
    )


def _service(cfg: Config) -> SortingService:
    return SortingService(
        config=cfg,
        config_service=ConfigService(cfg),
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
        db_manager=None,
    )


@pytest.fixture()
def run_with_orphan(tmp_path: Path) -> Any:
    """One photo plus one orphaned sidecar, with a hook to delete the sidecar.

    The sidecar has no primary of its own, so it is reported as an unmatched
    companion — one of the three records built with `_safe_stat`.
    """

    def _run(*, delete_orphan: bool) -> dict[str, Any]:
        source = tmp_path / "source"
        source.mkdir(exist_ok=True)
        _photo(source / "holiday.jpg")
        orphan = source / "orphan.aae"
        orphan.write_text("<plist/>", encoding="utf-8")

        # Fires between traversal and record-building: the file the run already
        # catalogued disappears underneath it, which is the real-world shape of
        # this failure (an external process, an unmounted volume, a revoked
        # permission) rather than something the run does to itself.
        def _vanish() -> None:
            if delete_orphan:
                orphan.unlink(missing_ok=True)

        task = _Task(on_checkpoint=_vanish)
        return asyncio.run(_service(_config(tmp_path)).run(cast("Task", task), dry_run=False))

    return _run


class TestAnUnreadableFileIsVisibleInTheRunStats:
    def test_a_sidecar_that_vanishes_mid_run_is_counted_as_unknown(
        self, run_with_orphan: Any
    ) -> None:
        stats = run_with_orphan(delete_orphan=True)

        assert stats["unmatched_companions"] == 1
        assert stats["unknown_size_count"] == 1

    def test_a_run_whose_files_all_stat_reports_no_unknowns(self, run_with_orphan: Any) -> None:
        """The guard against 'fixing' this by calling every size unknown."""
        stats = run_with_orphan(delete_orphan=False)

        assert stats["unmatched_companions"] == 1
        assert stats["unknown_size_count"] == 0


class TestThePreviewProducerAgrees:
    """The second producer of a size, with the same rule (`P1-FS-006(b)`).

    `_preview_file` recorded `0` for a file it could not stat, exactly as
    `_safe_stat` did. The frozen plan no longer takes its word for a size — it
    measures its own — but the preview record is still what the interface shows,
    and `0` there is the same lie on a different surface.
    """

    def _preview(self, tmp_path: Path, target: Path) -> dict[str, Any]:
        from app.services.duplicate_service import DuplicateRegistry, DuplicateService
        from app.services.preview_service import PreviewService
        from app.services.rule_engine_service import RuleEngineService

        source = tmp_path / "source"
        source.mkdir(exist_ok=True)
        (tmp_path / "target").mkdir(exist_ok=True)
        config = Config(
            source_directory=str(source),
            target_directory=str(tmp_path / "target"),
            sort=True,
            sort_criteria=["year"],
        )
        service = PreviewService(
            filesystem_service=FileSystemService(),
            extraction_service=DateExtractionService(),
            rule_engine_service=RuleEngineService(config=config),
            duplicate_service=DuplicateService(),
        )
        return service._preview_file(
            target,
            source,
            tmp_path / "target",
            config,
            DuplicateRegistry(),
            False,
        )

    def test_a_file_that_cannot_be_stat_ed_reports_no_size(self, tmp_path: Path) -> None:
        item = self._preview(tmp_path, tmp_path / "source" / "never-existed.jpg")

        assert item["file_size"] is None

    def test_a_real_file_still_reports_its_size(self, tmp_path: Path) -> None:
        """The guard against reporting every size as unknown."""
        source = tmp_path / "source"
        source.mkdir(exist_ok=True)
        photo = _photo(source / "real.jpg")

        item = self._preview(tmp_path, photo)

        assert item["file_size"] == photo.stat().st_size
