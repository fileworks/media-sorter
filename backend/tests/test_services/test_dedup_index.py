"""Tests for the persistent destination dedup index (P0-1)."""

from pathlib import Path

from PIL import Image

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
