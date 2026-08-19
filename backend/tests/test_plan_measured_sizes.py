"""C-10 on the persisted plan: a frozen size is measured, never inherited.

`P1-FS-006(b)` as written asks to widen `expected_size_bytes` to `int | None`
across the persisted surface. Measured against the code, that premise does not
hold, and the fix it implies would not have fixed the defect.

**Unknown cannot reach a frozen action.** `build_frozen_sort_plan` calls
`source_fingerprint(source_path)` on the line above `expected_size_bytes`, and
that stats the file unguarded. A source that cannot be stat'd raises there, so
no action is ever frozen for it — the same argument that keeps
`MutationManifestAction.expected_size_bytes` an `int`, since
`mutation_planner` re-stats at authorization time.

**What could go wrong was the opposite.** The size was taken from the *preview
record* (`int(item.get("file_size") or 0)`) while the fingerprint was measured
here and now. When the preview could not stat a file it recorded `0`, and that
`0` was frozen even though the stat on the line above had just succeeded. At
execution the engine measured the real size, the drift guard compared it against
`0`, and refused the file as `source_resized` — a wrong diagnosis of a file that
had never changed.

Both now come from one stat, so they cannot disagree and neither can be
fabricated. That satisfies the task's intent — unknown must not be conflated
with zero on the persisted surface — without widening a persisted schema, and
therefore without §17.18 Gate 3's forward-only rollback.
"""

from __future__ import annotations

from pathlib import Path

import pytest

from app.core.config import Config
from app.core.sort_plan import build_frozen_sort_plan, measured_identity


def _config(tmp_path: Path) -> Config:
    source = tmp_path / "source"
    source.mkdir(exist_ok=True)
    (tmp_path / "target").mkdir(exist_ok=True)
    return Config(source_directory=str(source), target_directory=str(tmp_path / "target"))


def _item(tmp_path: Path, name: str, *, reported_size: object) -> dict[str, object]:
    return {
        "source": str(tmp_path / "source" / name),
        "destination": str(tmp_path / "target" / "2024" / name),
        "status": "sort",
        "file_size": reported_size,
    }


class TestTheFrozenSizeIsMeasured:
    def test_a_stale_zero_from_the_preview_is_not_frozen(self, tmp_path: Path) -> None:
        """The live defect: the preview could not read it, the plan builder can."""
        config = _config(tmp_path)
        (tmp_path / "source" / "a.jpg").write_bytes(b"x" * 10)

        plan = build_frozen_sort_plan([_item(tmp_path, "a.jpg", reported_size=0)], config)

        assert [action.expected_size_bytes for action in plan.actions] == [10]

    def test_a_missing_size_from_the_preview_is_not_frozen_either(self, tmp_path: Path) -> None:
        config = _config(tmp_path)
        (tmp_path / "source" / "a.jpg").write_bytes(b"x" * 10)

        plan = build_frozen_sort_plan([_item(tmp_path, "a.jpg", reported_size=None)], config)

        assert [action.expected_size_bytes for action in plan.actions] == [10]

    def test_an_inflated_size_from_the_preview_is_not_frozen_either(self, tmp_path: Path) -> None:
        """The record is descriptive; the plan does not take its word for it."""
        config = _config(tmp_path)
        (tmp_path / "source" / "a.jpg").write_bytes(b"x" * 10)

        plan = build_frozen_sort_plan([_item(tmp_path, "a.jpg", reported_size=10_000_000)], config)

        assert [action.expected_size_bytes for action in plan.actions] == [10]

    def test_a_genuinely_empty_file_still_freezes_as_zero(self, tmp_path: Path) -> None:
        """`0` is a measured answer, and must survive the fix."""
        config = _config(tmp_path)
        (tmp_path / "source" / "empty.jpg").touch()

        plan = build_frozen_sort_plan([_item(tmp_path, "empty.jpg", reported_size=None)], config)

        assert [action.expected_size_bytes for action in plan.actions] == [0]


class TestUnknownCannotEnterThePlanAtAll:
    def test_an_unstatable_source_is_refused_rather_than_frozen(self, tmp_path: Path) -> None:
        """Why the persisted schema does not need widening.

        The fingerprint is measured on the line above the size, so a file that
        cannot be stat'd never reaches the size expression.
        """
        config = _config(tmp_path)

        with pytest.raises(OSError):
            build_frozen_sort_plan([_item(tmp_path, "gone.jpg", reported_size=None)], config)

    def test_every_frozen_size_is_an_integer(self, tmp_path: Path) -> None:
        config = _config(tmp_path)
        for index in range(3):
            (tmp_path / "source" / f"{index}.jpg").write_bytes(b"x" * (index + 1))

        plan = build_frozen_sort_plan(
            [_item(tmp_path, f"{index}.jpg", reported_size=None) for index in range(3)],
            config,
        )

        assert [action.expected_size_bytes for action in plan.actions] == [1, 2, 3]
        assert all(isinstance(action.expected_size_bytes, int) for action in plan.actions)


class TestTheFingerprintAndTheSizeAgree:
    def test_they_come_from_one_stat(self, tmp_path: Path) -> None:
        source = tmp_path / "a.jpg"
        source.write_bytes(b"x" * 42)

        fingerprint, size = measured_identity(source)

        assert size == 42
        # The fingerprint embeds the same size it was measured with, so a plan
        # cannot hold a fingerprint and a size that describe different moments.
        assert fingerprint.split(":")[2] == "42"

    def test_a_plan_action_carries_a_self_consistent_pair(self, tmp_path: Path) -> None:
        config = _config(tmp_path)
        (tmp_path / "source" / "a.jpg").write_bytes(b"x" * 7)

        (action,) = build_frozen_sort_plan(
            [_item(tmp_path, "a.jpg", reported_size=999)], config
        ).actions

        assert action.expected_size_bytes == 7
        assert action.source_fingerprint.split(":")[2] == "7"
