"""Tests for the persistent destination dedup index (P0-1)."""

import asyncio
import threading
import time
from pathlib import Path
from unittest.mock import patch

import pytest
from PIL import Image

from app.background_tasks.task_manager import CancellationToken, Task
from app.core.config import Config
from app.services.dedup_index import DedupIndex, resolve_index_path
from app.services.duplicate_service import DuplicateRegistry, DuplicateService


def _photo(path: Path, color: tuple[int, int, int] = (90, 120, 60)) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    img = Image.new("RGB", (256, 256))
    # A gradient so the perceptual hash carries real structure.
    for x in range(256):
        for y in range(256):
            img.putpixel((x, y), ((x + color[0]) % 256, (y + color[1]) % 256, color[2]))
    img.save(path)
    return path


class TestResolveIndexPath:
    def test_default_lives_inside_destination(self, tmp_path: Path) -> None:
        cfg = Config(target_directory=str(tmp_path))
        assert resolve_index_path(cfg) == tmp_path / ".mediasort-dedup-index.sqlite3"

    def test_explicit_override(self, tmp_path: Path) -> None:
        cfg = Config(target_directory=str(tmp_path), dedup_index_path=str(tmp_path / "i.db"))
        assert resolve_index_path(cfg) == tmp_path / "i.db"


class TestRefresh:
    def test_indexes_destination_media(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        _photo(dest / "2024" / "03" / "a.jpg")
        (dest / "2024" / "03" / "notes.txt").write_text("not media")

        index = DedupIndex(tmp_path / "index.db")
        stats = index.refresh(dest, DuplicateService(), perceptual=True, sample_video=False)
        assert stats.indexed == 1

        registry = index.load_registry()
        assert len(registry.exact) == 1
        assert len(registry.images) == 1
        assert registry.images[0].path.endswith("a.jpg")
        assert registry.images[0].mean_rgb is not None

    def test_incremental_reuse_and_removal(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        a = _photo(dest / "a.jpg")
        b = _photo(dest / "b.jpg", color=(10, 200, 40))
        index = DedupIndex(tmp_path / "index.db")
        svc = DuplicateService()

        first = index.refresh(dest, svc, perceptual=True, sample_video=False)
        assert first.indexed == 2

        b.unlink()
        second = index.refresh(dest, svc, perceptual=True, sample_video=False)
        assert second.indexed == 0  # a.jpg unchanged → signatures reused
        assert second.reused == 1
        assert second.removed == 1  # b.jpg row dropped

        registry = index.load_registry()
        assert [s.path for s in registry.images] == [str(a)]

    def test_quarantine_folders_are_not_indexed(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        _photo(dest / "2024" / "keep.jpg")
        _photo(dest / "_duplicates" / "dupe.jpg")
        _photo(dest / "_junk" / "tiny.jpg")

        index = DedupIndex(tmp_path / "index.db")
        index.refresh(dest, DuplicateService(), perceptual=True, sample_video=False)
        registry = index.load_registry()
        assert len(registry.images) == 1
        assert registry.images[0].path.endswith("keep.jpg")

    def test_exact_only_when_perceptual_disabled(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        _photo(dest / "a.jpg")
        index = DedupIndex(tmp_path / "index.db")
        index.refresh(dest, DuplicateService(), perceptual=False, sample_video=False)
        registry = index.load_registry()
        assert len(registry.exact) == 1
        assert registry.images == []

    def test_loaded_phash_matches_recomputed_signature(self, tmp_path: Path) -> None:
        """The hex round-trip must preserve the hash exactly, or thresholds drift."""
        dest = tmp_path / "dest"
        photo = _photo(dest / "a.jpg")
        svc = DuplicateService()
        index = DedupIndex(tmp_path / "index.db")
        index.refresh(dest, svc, perceptual=True, sample_video=False)

        loaded = index.load_registry().images[0]
        fresh = svc.image_signature(photo)
        assert fresh is not None
        assert svc.similarity_percent(loaded.phash, fresh.phash) == 100

    def test_refresh_exceeds_sqlite_variable_limit(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        dest.mkdir()
        for number in range(1_205):
            (dest / f"{number:04}.jpg").write_bytes(str(number).encode())

        index = DedupIndex(tmp_path / "index.db")
        stats = index.refresh(
            dest,
            DuplicateService(),
            perceptual=False,
            sample_video=False,
        )
        assert stats.indexed == 1_205
        assert len(index.load_registry().exact) == 1_205

    def test_partial_destination_walk_does_not_prune_unseen_rows(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        good = dest / "good.jpg"
        good.parent.mkdir()
        good.write_bytes(b"good")
        bad_dir = dest / "stale-subtree"
        bad_dir.mkdir()
        stale = bad_dir / "old.jpg"
        stale.write_bytes(b"old")
        index = DedupIndex(tmp_path / "index.db")
        service = DuplicateService()
        index.refresh(dest, service, perceptual=False, sample_video=False)
        stale.unlink()

        real_iterdir = Path.iterdir

        def partial_iterdir(path: Path):
            if path == bad_dir:
                raise PermissionError("offline")
            return real_iterdir(path)

        with patch.object(Path, "iterdir", partial_iterdir):
            stats = index.refresh(dest, service, perceptual=False, sample_video=False)

        assert stats.partial is True
        assert stats.removed == 0
        assert str(stale) in index.load_registry().exact.values()

    def test_cancellation_stops_insertion_and_skips_prune(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        dest.mkdir()
        stale = dest / "stale.jpg"
        stale.write_bytes(b"stale")
        index = DedupIndex(tmp_path / "index.db")
        index.refresh(dest, DuplicateService(), perceptual=False, sample_video=False)
        stale.unlink()
        for number in range(20):
            (dest / f"{number}.jpg").write_bytes(b"x" * 64)

        token = CancellationToken()
        service = DuplicateService()
        real_hash = service.compute_hash
        calls = 0

        def cancelling_hash(*args, **kwargs):
            nonlocal calls
            result = real_hash(*args, **kwargs)
            calls += 1
            if calls == 2:
                token.set()
            return result

        with patch.object(service, "compute_hash", side_effect=cancelling_hash):
            stats = index.refresh(
                dest,
                service,
                perceptual=False,
                sample_video=False,
                cancel_event=token,
                task=Task(id="index", operation_kind="sort"),
            )

        assert stats.cancelled is True
        assert stats.removed == 0
        assert str(stale) in index.load_registry().exact.values()

    def test_cancellation_after_final_insert_still_skips_prune(
        self,
        tmp_path: Path,
    ) -> None:
        dest = tmp_path / "dest"
        dest.mkdir()
        stale = dest / "stale.jpg"
        stale.write_bytes(b"stale")
        index = DedupIndex(tmp_path / "index.db")
        service = DuplicateService()
        index.refresh(dest, service, perceptual=False, sample_video=False)
        stale.unlink()
        (dest / "only-new.jpg").write_bytes(b"new")

        token = CancellationToken()
        real_hash = service.compute_hash

        def cancel_after_hash(*args, **kwargs):
            digest = real_hash(*args, **kwargs)
            token.set()
            return digest

        with patch.object(service, "compute_hash", side_effect=cancel_after_hash):
            stats = index.refresh(
                dest,
                service,
                perceptual=False,
                sample_video=False,
                cancel_event=token,
            )

        assert stats.cancelled is True
        assert stats.removed == 0
        assert str(stale) in index.load_registry().exact.values()


class TestScopedMatching:
    def test_destination_scope(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        placed = _photo(dest / "2024" / "a.jpg")
        index = DedupIndex(tmp_path / "index.db")
        svc = DuplicateService()
        index.refresh(dest, svc, perceptual=True, sample_video=False)
        dest_registry = index.load_registry()

        # Byte-identical source copy → destination scope, pointing at the placed file.
        source_copy = tmp_path / "src" / "copy.jpg"
        source_copy.parent.mkdir()
        source_copy.write_bytes(placed.read_bytes())
        match = svc.check_duplicate(
            source_copy, DuplicateRegistry(), destination_registry=dest_registry
        )
        assert match.is_duplicate and match.scope == "destination"
        assert match.original_path == str(placed)

    def test_perceptual_destination_match(self, tmp_path: Path) -> None:
        dest = tmp_path / "dest"
        _photo(dest / "a.jpg")
        index = DedupIndex(tmp_path / "index.db")
        svc = DuplicateService()
        index.refresh(dest, svc, perceptual=True, sample_video=False)
        dest_registry = index.load_registry()

        # Re-encoded (different bytes, same pixels) → perceptual destination match.
        recoded = tmp_path / "src" / "recoded.jpg"
        _photo(recoded)  # same deterministic gradient, fresh encode
        match = svc.check_duplicate(
            recoded, DuplicateRegistry(), destination_registry=dest_registry, threshold=95
        )
        assert match.is_duplicate
        assert match.scope == "destination"
        assert match.match_type in ("exact", "perceptual")

    def test_run_scope_unaffected_without_destination_registry(self, tmp_path: Path) -> None:
        a = _photo(tmp_path / "a.jpg")
        b = tmp_path / "b.jpg"
        b.write_bytes(a.read_bytes())
        svc = DuplicateService()
        registry = DuplicateRegistry()
        assert not svc.check_duplicate(a, registry).is_duplicate
        match = svc.check_duplicate(b, registry)
        assert match.is_duplicate and match.scope == "run"

    def test_destination_match_takes_precedence_over_run_registry(
        self,
        tmp_path: Path,
    ) -> None:
        source = tmp_path / "source.jpg"
        source.write_bytes(b"same")
        digest = DuplicateService.compute_hash(source)
        run_registry = DuplicateRegistry(exact={digest: "/run/original.jpg"})
        destination_registry = DuplicateRegistry(exact={digest: "/destination/original.jpg"})

        match = DuplicateService().check_duplicate(
            source,
            run_registry,
            destination_registry=destination_registry,
            perceptual=False,
        )

        assert match.scope == "destination"
        assert match.original_path == "/destination/original.jpg"


@pytest.mark.asyncio
async def test_destination_index_worker_observes_cancellation_before_later_phase(
    tmp_path: Path,
) -> None:
    dest = tmp_path / "dest"
    dest.mkdir()
    (dest / "photo.jpg").write_bytes(b"media")
    index = DedupIndex(tmp_path / "index.db")
    service = DuplicateService()
    token = CancellationToken()
    task = Task(id="index-thread", operation_kind="preview")
    entered = threading.Event()
    real_hash = service.compute_hash

    def waiting_hash(*args, **kwargs):
        entered.set()
        while not token.is_set():
            time.sleep(0.001)
        return real_hash(*args, **kwargs)

    with patch.object(service, "compute_hash", side_effect=waiting_hash):
        pending = asyncio.create_task(
            asyncio.to_thread(
                index.refresh,
                dest,
                service,
                perceptual=False,
                sample_video=False,
                cancel_event=token,
                task=task,
            )
        )
        assert await asyncio.to_thread(entered.wait, 1)
        token.set()
        stats = await pending

    assert stats.cancelled is True
    assert task.progress.phase == "indexing_destination"
    assert {event.phase for event in task.events if event.name == "operation.phase"} == {
        "indexing_destination"
    }
