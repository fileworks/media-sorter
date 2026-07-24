"""Shared source-validation and traversal reliability contracts."""

from __future__ import annotations

import asyncio
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest

from app.background_tasks.task_manager import CancellationToken, Task
from app.core.exceptions import SourceUnavailableError
from app.services.filesystem_service import FileSystemService
from app.utils.path_utils import validate_source_root


def test_valid_empty_source_is_not_an_error(tmp_path: Path) -> None:
    root = validate_source_root(str(tmp_path))
    result = asyncio.run(FileSystemService().traverse(root))
    assert result.files == []
    assert result.partial is False
    assert result.cancelled is False


@pytest.mark.parametrize("value", ["", "   ", None])
def test_unset_source_has_one_structured_error(value: str | None) -> None:
    with pytest.raises(SourceUnavailableError) as excinfo:
        validate_source_root(value)
    assert excinfo.value.code == "SOURCE_UNAVAILABLE"
    assert excinfo.value.details["reason"] == "unset"


def test_missing_and_non_directory_sources_have_structured_reasons(tmp_path: Path) -> None:
    missing = tmp_path / "offline"
    with pytest.raises(SourceUnavailableError) as missing_error:
        validate_source_root(str(missing))
    assert missing_error.value.details == {
        "path": str(missing),
        "reason": "missing",
    }

    file_path = tmp_path / "photo.jpg"
    file_path.write_bytes(b"x")
    with pytest.raises(SourceUnavailableError) as file_error:
        validate_source_root(str(file_path))
    assert file_error.value.details == {
        "path": str(file_path),
        "reason": "not_directory",
    }


def test_root_probe_failure_is_terminal(tmp_path: Path) -> None:
    with patch("app.utils.path_utils.os.scandir", side_effect=PermissionError("denied")):
        with pytest.raises(SourceUnavailableError) as excinfo:
            validate_source_root(str(tmp_path))
    assert excinfo.value.details["reason"] == "root_inaccessible"


def test_recursion_depth_exclusions_and_size_use_one_contract(tmp_path: Path) -> None:
    root_file = tmp_path / "root.jpg"
    root_file.write_bytes(b"x" * 2048)
    child = tmp_path / "child"
    child.mkdir()
    (child / "included.jpg").write_bytes(b"x" * 2048)
    (child / "small.jpg").write_bytes(b"x")
    grandchild = child / "deep"
    grandchild.mkdir()
    (grandchild / "too-deep.jpg").write_bytes(b"x" * 2048)
    excluded = tmp_path / "skip"
    excluded.mkdir()
    (excluded / "hidden.jpg").write_bytes(b"x" * 2048)

    service = FileSystemService()
    flat = asyncio.run(service.traverse(tmp_path, recursive=False))
    assert flat.files == [root_file]

    bounded = asyncio.run(
        service.traverse(
            tmp_path,
            recursive=True,
            max_depth=1,
            exclude_patterns=["skip"],
            min_file_size_kb=1,
        )
    )
    assert bounded.files == [child / "included.jpg", root_file]
    assert bounded.excluded_by_size == 1
    assert bounded.excluded_directories == 1


def test_cancellation_during_directory_iteration_is_observed(tmp_path: Path) -> None:
    for number in range(20):
        (tmp_path / f"{number:02}.jpg").write_bytes(b"x")
    token = CancellationToken()
    real_iterdir = Path.iterdir

    def cancelling_iterdir(path: Path):
        for index, entry in enumerate(real_iterdir(path)):
            if index == 3:
                token.set()
            yield entry

    with patch.object(Path, "iterdir", cancelling_iterdir):
        result = FileSystemService()._traverse_sync(tmp_path, True, None, [], None, None, token)
    assert result.cancelled is True
    assert len(result.files) < 20


@pytest.mark.asyncio
async def test_worker_thread_traversal_observes_cancellation(tmp_path: Path) -> None:
    (tmp_path / "photo.jpg").write_bytes(b"x")
    token = CancellationToken()
    entered = threading.Event()
    real_iterdir = Path.iterdir

    def waiting_iterdir(path: Path):
        entered.set()
        while not token.is_set():
            time.sleep(0.001)
        return real_iterdir(path)

    service = FileSystemService()
    with patch.object(Path, "iterdir", waiting_iterdir):
        pending = asyncio.create_task(service.traverse(tmp_path, cancel_token=token))
        assert await asyncio.to_thread(entered.wait, 1)
        token.set()
        result = await pending

    assert result.cancelled is True
    assert result.files == []


def test_local_child_oserror_is_partial_but_root_oserror_fails(tmp_path: Path) -> None:
    good = tmp_path / "good"
    good.mkdir()
    photo = good / "photo.jpg"
    photo.write_bytes(b"x")
    bad = tmp_path / "bad"
    bad.mkdir()
    real_iterdir = Path.iterdir

    def flaky_iterdir(path: Path):
        if path == bad:
            raise PermissionError("child denied")
        return real_iterdir(path)

    service = FileSystemService()
    with patch.object(Path, "iterdir", flaky_iterdir):
        result = asyncio.run(service.traverse(tmp_path))
    assert result.files == [photo]
    assert result.partial is True
    assert result.issues[0].path == str(bad)
    assert result.issues[0].error_class == "PermissionError"

    with (
        patch.object(Path, "iterdir", side_effect=OSError("root stale")),
        pytest.raises(SourceUnavailableError),
    ):
        asyncio.run(service.traverse(tmp_path))


@pytest.mark.asyncio
async def test_partial_issue_log_is_correlated_with_safe_path_context(
    tmp_path: Path,
) -> None:
    bad = tmp_path / "offline"
    bad.mkdir()
    real_iterdir = Path.iterdir

    def flaky_iterdir(path: Path):
        if path == bad:
            raise PermissionError("child denied")
        return real_iterdir(path)

    task = Task(id="scan-partial", operation_kind="scan")
    task.transition("scanning_source")
    with (
        patch.object(Path, "iterdir", flaky_iterdir),
        patch("app.services.filesystem_service.logger") as traversal_logger,
    ):
        result = await FileSystemService().traverse(tmp_path, task=task)

    assert result.partial is True
    correlated = [
        call
        for call in traversal_logger.warning.call_args_list
        if call.args[0] == "operation.partial" and call.kwargs.get("task_id")
    ]
    assert len(correlated) == 1
    assert correlated[0].kwargs == {
        "task_id": "scan-partial",
        "operation_kind": "scan",
        "phase": "scanning_source",
        "path": str(bad),
        "error_class": "PermissionError",
        "error": "child denied",
    }
