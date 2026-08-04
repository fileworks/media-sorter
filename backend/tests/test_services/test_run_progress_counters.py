"""The live counters the Execute screen reads while a run is in flight.

The screen's "so far" panel is not decoration: during a twenty-minute operation
it is the only evidence that the run is doing what was agreed. So the counters
have to be tallied as the work happens, not reconstructed from the report at
the end, and the name-collision tally in particular has to be a delta — files
that had to be renamed because another file claimed the name first.
"""

from __future__ import annotations

import asyncio
from pathlib import Path
from typing import Any, cast

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


def _photo(path: Path, seed: int) -> Path:
    """A deterministic noise JPEG, unique per seed so nothing dedups by accident."""
    import random

    rng = random.Random(seed)
    path.parent.mkdir(parents=True, exist_ok=True)
    raw = bytes(rng.randrange(256) for _ in range(64 * 64 * 3))
    Image.frombytes("RGB", (64, 64), raw).save(path, quality=95)
    return path


def _config(tmp_path: Path, **overrides: Any) -> Config:
    defaults: dict[str, Any] = {
        "source_directory": str(tmp_path / "source"),
        "target_directory": str(tmp_path / "target"),
        "sort_criteria": ["year"],
        "copy_instead_of_move": True,
        "remove_duplicates": False,
        "repair_enabled": False,
        # Every file gets the same generated name, which is what forces the
        # collision path this test is about.
        "rename": True,
        "rename_pattern": "shot",
    }
    defaults.update(overrides)
    (tmp_path / "source").mkdir(exist_ok=True)
    (tmp_path / "target").mkdir(exist_ok=True)
    return Config(**defaults)


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


class _RecordingTask:
    """A task that tallies outcomes the way the real one does."""

    class _Progress:
        def __init__(self) -> None:
            self.current = 0
            self.total = 0
            self.percentage = 0.0
            self.estimated_time_remaining_seconds: float | None = None
            self.phase = ""
            self.outcomes: dict[str, int] = {}
            self.last_checkpoint_label = ""

    def __init__(self) -> None:
        self.progress = self._Progress()
        self.cancel_event = asyncio.Event()

    def record_outcome(self, code: str, *, count: int = 1) -> None:
        self.progress.outcomes[code] = self.progress.outcomes.get(code, 0) + count

    def checkpoint(self, label: str) -> None:  # pragma: no cover - not asserted here
        self.progress.last_checkpoint_label = label

    def transition(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass

    def update_progress(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass

    def mark_partial(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass

    def add_event(self, *args: Any, **kwargs: Any) -> None:  # pragma: no cover
        pass


def _placed(task: _RecordingTask) -> int:
    """Files the run actually placed, however the engine spells that outcome."""
    return sum(
        count for code, count in task.progress.outcomes.items() if code not in {"name_collision"}
    )


def test_name_collisions_are_tallied_as_they_happen(tmp_path: Path) -> None:
    source = tmp_path / "source"
    for index in range(3):
        _photo(source / f"original-{index}.jpg", seed=index)

    task = _RecordingTask()
    stats = asyncio.run(_service(_config(tmp_path)).run(task, dry_run=False))

    assert stats["sorted"] == 3
    # Three files, one name: the first keeps it, the other two are suffixed.
    assert task.progress.outcomes["name_collision"] == 2
    assert _placed(task) == 3

    landed = sorted(p.name for p in (tmp_path / "target").rglob("*.jpg"))
    assert len(landed) == 3
    assert len(set(landed)) == 3, landed


def test_a_run_without_collisions_reports_none(tmp_path: Path) -> None:
    source = tmp_path / "source"
    for index in range(3):
        _photo(source / f"original-{index}.jpg", seed=index)

    task = _RecordingTask()
    # Original names are already unique, so nothing has to be suffixed.
    asyncio.run(_service(_config(tmp_path, rename=False)).run(task, dry_run=False))

    assert "name_collision" not in task.progress.outcomes
    assert _placed(task) == 3


def test_the_collision_tally_starts_from_zero_on_every_run(tmp_path: Path) -> None:
    source = tmp_path / "source"
    _photo(source / "a.jpg", seed=1)
    _photo(source / "b.jpg", seed=2)

    service = _service(_config(tmp_path))

    first = _RecordingTask()
    asyncio.run(service.run(cast("Task", first), dry_run=True))
    second = _RecordingTask()
    asyncio.run(service.run(cast("Task", second), dry_run=True))

    # A second run on the same service instance must not inherit the first's
    # count — otherwise the panel would climb forever across runs.
    assert first.progress.outcomes.get("name_collision") == second.progress.outcomes.get(
        "name_collision"
    )
