"""Tests for AnalysisService."""

import asyncio
from pathlib import Path

import pytest

from app.core.config import Config
from app.services.analysis_service import AnalysisService
from app.services.filesystem_service import FileSystemService


@pytest.fixture()
def fs_svc() -> FileSystemService:
    return FileSystemService()


@pytest.fixture()
def svc(fs_svc: FileSystemService) -> AnalysisService:
    return AnalysisService(filesystem_service=fs_svc)


def test_empty_source_returns_empty_result(svc: AnalysisService, tmp_path: Path) -> None:
    config = Config(source_directory=str(tmp_path / "nonexistent"), target_directory=str(tmp_path))
    result = asyncio.run(svc.analyse(config))
    assert result["total_files"] == 0
    assert result["by_type"] == {}


def test_analyse_counts_files(svc: AnalysisService, tmp_path: Path) -> None:
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\xff\xd8\xff" + b"\x00" * 1000)
    (src / "video.mp4").write_bytes(b"\x00" * 2000)
    config = Config(source_directory=str(src), target_directory=str(tmp_path / "dest"))
    result = asyncio.run(svc.analyse(config))
    assert result["total_files"] == 2
    assert result["total_size_bytes"] > 0


def test_analyse_by_type_grouping(svc: AnalysisService, tmp_path: Path) -> None:
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\x00" * 100)
    (src / "photo2.jpeg").write_bytes(b"\x00" * 100)
    (src / "raw.arw").write_bytes(b"\x00" * 200)
    (src / "clip.mp4").write_bytes(b"\x00" * 300)
    config = Config(source_directory=str(src), target_directory=str(tmp_path / "dest"))
    result = asyncio.run(svc.analyse(config))
    assert result["by_type"].get("jpeg", 0) == 2
    assert result["by_type"].get("raw", 0) == 1
    assert result["by_type"].get("mp4", 0) == 1


def test_analyse_excluded_directory_is_pruned(svc: AnalysisService, tmp_path: Path) -> None:
    """An excluded directory is pruned without entering it (exclusion costs no
    I/O), so its contents are neither counted as files nor as exclusions —
    matching how the sort's walker treats it."""
    src = tmp_path / "source"
    src.mkdir()
    thumb_dir = src / "@eaDir"
    thumb_dir.mkdir()
    (thumb_dir / "thumb.jpg").write_bytes(b"\x00" * 100)
    (src / "real.jpg").write_bytes(b"\x00" * 200)
    config = Config(
        source_directory=str(src),
        target_directory=str(tmp_path / "dest"),
        exclude_patterns=["@eaDir"],
    )
    result = asyncio.run(svc.analyse(config))
    assert result["total_files"] == 1
    assert result["excluded_files"] == 0


def test_analyse_excluded_file_pattern_is_counted(svc: AnalysisService, tmp_path: Path) -> None:
    """A file excluded by pattern (not via a pruned directory) is counted."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "IMG_screenshot.jpg").write_bytes(b"\x00" * 100)
    (src / "real.jpg").write_bytes(b"\x00" * 200)
    config = Config(
        source_directory=str(src),
        target_directory=str(tmp_path / "dest"),
        exclude_patterns=["*screenshot*"],
    )
    result = asyncio.run(svc.analyse(config))
    assert result["total_files"] == 1
    assert result["excluded_files"] == 1


def test_disk_space_check(svc: AnalysisService, tmp_path: Path) -> None:
    src = tmp_path / "source"
    src.mkdir()
    dst = tmp_path / "dest"
    dst.mkdir()
    config = Config(source_directory=str(src), target_directory=str(dst))
    result = asyncio.run(svc.disk_space_check(config))
    assert "source_size_bytes" in result
    assert "destination_free_bytes" in result
    assert "sufficient" in result
    assert result["mode"] in ("copy", "move")


def test_disk_space_counts_only_filtered_media(svc: AnalysisService, tmp_path: Path) -> None:
    """disk_space_check sizes only the media a sort acts on — ignoring non-media
    and exclude patterns — so it agrees with the analysis report."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\x00" * 1000)  # counted
    (src / "notes.txt").write_bytes(b"\x00" * 5000)  # non-media → ignored
    excluded = src / "@eaDir"
    excluded.mkdir()
    (excluded / "thumb.jpg").write_bytes(b"\x00" * 2000)  # excluded by pattern
    config = Config(
        source_directory=str(src),
        target_directory=str(tmp_path / "dest"),
        copy_instead_of_move=True,
        exclude_patterns=["@eaDir"],
    )
    ds = asyncio.run(svc.disk_space_check(config))
    analysis = asyncio.run(svc.analyse(config))
    assert ds["source_size_bytes"] == 1000
    assert ds["source_size_bytes"] == analysis["total_size_bytes"]


def test_non_recursive_scan_counts_only_top_level(svc: AnalysisService, tmp_path: Path) -> None:
    """With recursive_scan off, analysis and the disk-space check must count only
    the top-level media a sort would touch — not files in subfolders — and still
    agree with each other."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "top.jpg").write_bytes(b"\x00" * 1000)  # counted
    nested = src / "vacation"
    nested.mkdir()
    (nested / "deep.jpg").write_bytes(b"\x00" * 4000)  # subfolder → ignored
    config = Config(
        source_directory=str(src),
        target_directory=str(tmp_path / "dest"),
        copy_instead_of_move=True,
        recursive_scan=False,
    )
    analysis = asyncio.run(svc.analyse(config))
    ds = asyncio.run(svc.disk_space_check(config))
    assert analysis["total_files"] == 1
    assert analysis["total_size_bytes"] == 1000
    assert ds["source_size_bytes"] == 1000
    assert ds["source_size_bytes"] == analysis["total_size_bytes"]


def test_max_depth_limits_traversal(svc: AnalysisService, tmp_path: Path) -> None:
    """max_recursion_depth caps how deep analysis descends, matching the sort."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "a.jpg").write_bytes(b"\x00" * 100)  # root → counted
    level1 = src / "l1"
    level1.mkdir()
    (level1 / "b.jpg").write_bytes(b"\x00" * 100)  # one level down → counted
    level2 = level1 / "l2"
    level2.mkdir()
    (level2 / "c.jpg").write_bytes(b"\x00" * 100)  # two levels down → beyond max_depth=1
    config = Config(
        source_directory=str(src),
        target_directory=str(tmp_path / "dest"),
        recursive_scan=True,
        max_recursion_depth=1,
    )
    analysis = asyncio.run(svc.analyse(config))
    # depth 0 (a.jpg) + one level down (b.jpg); l2/c.jpg is beyond the cap.
    assert analysis["total_files"] == 2


def test_analyse_disk_space_structure(svc: AnalysisService, tmp_path: Path) -> None:
    src = tmp_path / "source"
    src.mkdir()
    config = Config(source_directory=str(src), target_directory=str(tmp_path / "dest"))
    result = asyncio.run(svc.analyse(config))
    ds = result["disk_space"]
    assert "source_size_bytes" in ds
    assert "destination_free_bytes" in ds
    assert "sufficient" in ds
    assert "mode" in ds
    assert "free_space_known" in ds


def test_disk_space_check_known_for_nested_nonexistent_dest(
    svc: AnalysisService, tmp_path: Path
) -> None:
    """A normal not-yet-created nested destination still has known free space and a
    real free-bytes figure — this is the bug fix (previously 0 / mislabelled)."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\x00" * 1000)
    dest = tmp_path / "out" / "sorted"  # 2 levels deep, neither exists yet
    config = Config(
        source_directory=str(src),
        target_directory=str(dest),
        copy_instead_of_move=True,
    )
    ds = asyncio.run(svc.disk_space_check(config))
    assert ds["free_space_known"] is True
    assert ds["destination_free_bytes"] > 0
    # Plenty of room for 1 KB → sufficient.
    assert ds["sufficient"] is True


def test_analyse_known_for_nested_nonexistent_dest(svc: AnalysisService, tmp_path: Path) -> None:
    """_analyse_sync reports the same known/real free space for a nested dest."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\x00" * 1000)
    dest = tmp_path / "out" / "sorted"
    config = Config(
        source_directory=str(src),
        target_directory=str(dest),
        copy_instead_of_move=True,
    )
    ds = asyncio.run(svc.analyse(config))["disk_space"]
    assert ds["free_space_known"] is True
    assert ds["destination_free_bytes"] > 0
    assert ds["sufficient"] is True


def test_disk_space_check_unknown_does_not_block(
    monkeypatch: pytest.MonkeyPatch, svc: AnalysisService, tmp_path: Path
) -> None:
    """When free space is unreadable, copy is not falsely blocked: sufficient=True
    but free_space_known=False and destination_free_bytes=0."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\x00" * 1000)
    config = Config(
        source_directory=str(src),
        target_directory=str(tmp_path / "dest"),
        copy_instead_of_move=True,
    )
    monkeypatch.setattr(svc._fs, "get_available_space", lambda _path: None)
    ds = asyncio.run(svc.disk_space_check(config))
    assert ds["free_space_known"] is False
    assert ds["destination_free_bytes"] == 0
    assert ds["sufficient"] is True


def test_disk_space_check_insufficient_when_known_and_too_small(
    monkeypatch: pytest.MonkeyPatch, svc: AnalysisService, tmp_path: Path
) -> None:
    """Known free space below the source+headroom marks copy insufficient."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\x00" * 10_000)
    config = Config(
        source_directory=str(src),
        target_directory=str(tmp_path / "dest"),
        copy_instead_of_move=True,
    )
    monkeypatch.setattr(svc._fs, "get_available_space", lambda _path: 5_000)
    ds = asyncio.run(svc.disk_space_check(config))
    assert ds["free_space_known"] is True
    assert ds["destination_free_bytes"] == 5_000
    assert ds["sufficient"] is False


def test_empty_result_disk_space_known_false(svc: AnalysisService, tmp_path: Path) -> None:
    """No source ⇒ empty result reports free_space_known=False (never a fake 0-as-known)."""
    config = Config(source_directory=str(tmp_path / "missing"), target_directory=str(tmp_path))
    ds = asyncio.run(svc.analyse(config))["disk_space"]
    assert ds["free_space_known"] is False
    assert ds["destination_free_bytes"] == 0


def test_disk_space_check_tolerates_inaccessible_dest(
    monkeypatch: pytest.MonkeyPatch, svc: AnalysisService, tmp_path: Path
) -> None:
    """A destination whose exists() raises (macOS TCC) degrades to unknown, not 500."""
    src = tmp_path / "source"
    src.mkdir()
    (src / "photo.jpg").write_bytes(b"\x00" * 1000)
    blocked = tmp_path / "blocked"
    config = Config(
        source_directory=str(src),
        target_directory=str(blocked),
        copy_instead_of_move=True,
    )

    real_exists = Path.exists

    def selective_exists(self: Path) -> bool:
        if self == blocked:
            raise PermissionError("operation not permitted")
        return real_exists(self)

    monkeypatch.setattr(Path, "exists", selective_exists)
    ds = asyncio.run(svc.disk_space_check(config))
    assert ds["free_space_known"] is False
    assert ds["sufficient"] is True
