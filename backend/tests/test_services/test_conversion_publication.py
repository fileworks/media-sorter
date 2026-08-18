"""C-01/C-09: a conversion must never be why the only copy is gone.

Before this task the sort path did::

    converted = convert_image(source=dest, ...)
    if converted != dest:
        dest.unlink(missing_ok=True)
        dest = converted

`dest` is the *published* file — in move mode the user's only copy — and
nothing checked `converted` first. These tests inject exactly that: a converter
that returns a corrupt, empty, truncated or wrong-sized candidate, and a crash
between staging and publication. Every one of them asserts the original is
still recoverable.
"""

from __future__ import annotations

import shutil
import subprocess
from pathlib import Path

import pytest

from app.services.conversion_guard import (
    ConversionCandidateRejected,
    validate_converted_image,
    validate_converted_video,
)
from app.services.conversion_publication import (
    ConversionPublicationError,
    promote_no_clobber,
    publish_converted_file,
    stage_directory,
)
from app.services.quarantine import QuarantineStore

PIL_Image = pytest.importorskip("PIL.Image")

FFMPEG = shutil.which("ffmpeg")
needs_ffmpeg = pytest.mark.skipif(FFMPEG is None, reason="ffmpeg is not installed")


def _png(path: Path, size: tuple[int, int] = (64, 48)) -> Path:
    PIL_Image.new("RGB", size, "red").save(path)
    return path


def _store(tmp_path: Path) -> QuarantineStore:
    return QuarantineStore(tmp_path / "state" / "quarantine")


def _video(path: Path, seconds: float = 1.0) -> Path:
    subprocess.run(
        [
            "ffmpeg",
            "-v",
            "error",
            "-y",
            "-f",
            "lavfi",
            "-i",
            f"testsrc=duration={seconds}:size=64x48:rate=25",
            "-f",
            "lavfi",
            "-i",
            f"sine=duration={seconds}:frequency=440",
            "-c:v",
            "libx264",
            "-pix_fmt",
            "yuv420p",
            "-c:a",
            "aac",
            str(path),
        ],
        check=True,
        capture_output=True,
    )
    return path


# ------------------------------------------------------------------ #
# The proof itself                                                    #
# ------------------------------------------------------------------ #


class TestImageProof:
    def test_a_complete_conversion_proves_itself(self, tmp_path: Path) -> None:
        original = _png(tmp_path / "a.png")
        candidate = tmp_path / "a.jpg"
        PIL_Image.open(original).convert("RGB").save(candidate)

        proof = validate_converted_image(original, candidate, expected_suffix=".jpg")

        assert proof.media == "image"
        assert len(proof.sha256) == 64
        assert proof.size_bytes == candidate.stat().st_size

    def test_an_empty_candidate_is_refused(self, tmp_path: Path) -> None:
        original = _png(tmp_path / "a.png")
        candidate = tmp_path / "a.jpg"
        candidate.touch()

        with pytest.raises(ConversionCandidateRejected, match="empty"):
            validate_converted_image(original, candidate, expected_suffix=".jpg")

    def test_a_truncated_candidate_is_refused(self, tmp_path: Path) -> None:
        original = _png(tmp_path / "a.png")
        candidate = tmp_path / "a.jpg"
        PIL_Image.open(original).convert("RGB").save(candidate)
        whole = candidate.read_bytes()
        candidate.write_bytes(whole[: len(whole) // 3])

        # Pillow may refuse at open or at full decode depending on where the
        # truncation lands; both are refusals, and either is the point.
        with pytest.raises(ConversionCandidateRejected, match="did not decode|could not be opened"):
            validate_converted_image(original, candidate, expected_suffix=".jpg")

    def test_a_resized_candidate_is_refused(self, tmp_path: Path) -> None:
        original = _png(tmp_path / "a.png", size=(64, 48))
        candidate = _png(tmp_path / "a.jpg", size=(32, 24))

        with pytest.raises(ConversionCandidateRejected, match="32x24"):
            validate_converted_image(original, candidate, expected_suffix=".jpg")

    def test_a_candidate_in_the_wrong_format_is_refused(self, tmp_path: Path) -> None:
        original = _png(tmp_path / "a.png")
        candidate = _png(tmp_path / "a.webp")

        with pytest.raises(ConversionCandidateRejected, match="not the planned"):
            validate_converted_image(original, candidate, expected_suffix=".jpg")

    def test_a_symlink_candidate_is_refused(self, tmp_path: Path) -> None:
        original = _png(tmp_path / "a.png")
        real = _png(tmp_path / "real.jpg")
        candidate = tmp_path / "a.jpg"
        candidate.symlink_to(real)

        with pytest.raises(ConversionCandidateRejected, match="symlink"):
            validate_converted_image(original, candidate, expected_suffix=".jpg")


@needs_ffmpeg
class TestVideoProof:
    def test_a_complete_transcode_proves_itself(self, tmp_path: Path) -> None:
        original = _video(tmp_path / "a.mp4")
        candidate = tmp_path / "a.mkv"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(original),
                "-map",
                "0:v?",
                "-map",
                "0:a?",
                "-c",
                "copy",
                str(candidate),
            ],
            check=True,
            capture_output=True,
        )

        proof = validate_converted_video(original, candidate, expected_suffix=".mkv")

        assert proof.media == "video"
        assert "1 video" in proof.detail and "1 audio" in proof.detail

    def test_a_transcode_that_dropped_the_audio_is_refused(self, tmp_path: Path) -> None:
        original = _video(tmp_path / "a.mp4")
        candidate = tmp_path / "a.mkv"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(original),
                "-map",
                "0:v:0",
                "-c",
                "copy",
                str(candidate),
            ],
            check=True,
            capture_output=True,
        )

        with pytest.raises(ConversionCandidateRejected, match="stream counts changed"):
            validate_converted_video(original, candidate, expected_suffix=".mkv")

    def test_a_truncated_transcode_is_refused_on_duration(self, tmp_path: Path) -> None:
        original = _video(tmp_path / "a.mp4", seconds=2.0)
        candidate = tmp_path / "a.mkv"
        subprocess.run(
            [
                "ffmpeg",
                "-v",
                "error",
                "-y",
                "-i",
                str(original),
                "-t",
                "0.5",
                "-map",
                "0:v?",
                "-map",
                "0:a?",
                "-c",
                "copy",
                str(candidate),
            ],
            check=True,
            capture_output=True,
        )

        with pytest.raises(ConversionCandidateRejected, match="duration drifted"):
            validate_converted_video(original, candidate, expected_suffix=".mkv")

    def test_an_unprobeable_candidate_is_refused(self, tmp_path: Path) -> None:
        original = _video(tmp_path / "a.mp4")
        candidate = tmp_path / "a.mkv"
        candidate.write_bytes(b"this is not a video")

        with pytest.raises(ConversionCandidateRejected):
            validate_converted_video(original, candidate, expected_suffix=".mkv")


# ------------------------------------------------------------------ #
# Publication: the original survives every rejection and every crash  #
# ------------------------------------------------------------------ #


class TestPublication:
    def test_a_proven_candidate_publishes_and_the_original_is_recoverable(
        self, tmp_path: Path
    ) -> None:
        published = tmp_path / "lib" / "a.png"
        published.parent.mkdir()
        _png(published)
        original_bytes = published.read_bytes()
        store = _store(tmp_path)

        def convert(source: Path) -> Path:
            stage = stage_directory(source, "op1")
            stage.mkdir(parents=True, exist_ok=True)
            candidate = stage / "a.jpg"
            PIL_Image.open(source).convert("RGB").save(candidate)
            return candidate

        result = publish_converted_file(
            published,
            convert=convert,
            expected_suffix=".jpg",
            media="image",
            quarantine=store,
            operation_id="op1",
        )

        assert result.converted
        assert result.published_path == tmp_path / "lib" / "a.jpg"
        assert result.published_path.is_file()
        # The original is not gone — it is in the store, with a record.
        assert not published.exists()
        record = result.quarantine_record
        assert record is not None
        assert record.reason == "optimization_original"
        assert Path(record.quarantine_path).read_bytes() == original_bytes
        # And the intent that protected it is committed, not dangling.
        assert store.pending_intents() == ()
        # Staging leaves nothing behind in the published tree.
        assert not (published.parent / ".mediasort-stage").exists()

    @pytest.mark.parametrize(
        "sabotage",
        ["empty", "truncated", "resized", "raises"],
        ids=["empty candidate", "truncated candidate", "resized candidate", "converter raises"],
    )
    def test_a_candidate_that_cannot_prove_itself_never_displaces_the_original(
        self, tmp_path: Path, sabotage: str
    ) -> None:
        published = tmp_path / "lib" / "a.png"
        published.parent.mkdir()
        _png(published)
        before = published.read_bytes()
        store = _store(tmp_path)

        def convert(source: Path) -> Path:
            stage = stage_directory(source, "op1")
            stage.mkdir(parents=True, exist_ok=True)
            candidate = stage / "a.jpg"
            if sabotage == "raises":
                raise RuntimeError("encoder exploded")
            if sabotage == "empty":
                candidate.touch()
            elif sabotage == "truncated":
                PIL_Image.open(source).convert("RGB").save(candidate)
                whole = candidate.read_bytes()
                candidate.write_bytes(whole[: len(whole) // 3])
            else:
                _png(candidate, size=(8, 8))
            return candidate

        result = publish_converted_file(
            published,
            convert=convert,
            expected_suffix=".jpg",
            media="image",
            quarantine=store,
            operation_id="op1",
        )

        assert not result.converted
        assert result.kept_original_because
        assert result.published_path == published
        assert published.read_bytes() == before, "the verified original was destroyed"
        assert store.records() == (), "nothing should have been quarantined"
        assert store.pending_intents() == (), "no intent should be left dangling"

    def test_a_failed_quarantine_refuses_rather_than_publishing_anyway(
        self, tmp_path: Path, monkeypatch: pytest.MonkeyPatch
    ) -> None:
        """A masked quarantine failure is how an original disappears quietly."""
        published = tmp_path / "lib" / "a.png"
        published.parent.mkdir()
        _png(published)
        before = published.read_bytes()
        store = _store(tmp_path)

        def refuse(*args: object, **kwargs: object) -> object:
            raise OSError("quarantine volume is read-only")

        monkeypatch.setattr(store, "quarantine", refuse)

        def convert(source: Path) -> Path:
            stage = stage_directory(source, "op1")
            stage.mkdir(parents=True, exist_ok=True)
            candidate = stage / "a.jpg"
            PIL_Image.open(source).convert("RGB").save(candidate)
            return candidate

        with pytest.raises(ConversionPublicationError, match="could not quarantine"):
            publish_converted_file(
                published,
                convert=convert,
                expected_suffix=".jpg",
                media="image",
                quarantine=store,
                operation_id="op1",
            )

        assert published.read_bytes() == before
        # The intent is abandoned on the record, so recovery is not left guessing.
        assert [intent.state for intent in store.intents()] == ["abandoned"]
        assert store.pending_intents() == ()


class TestNoClobberPromotion:
    def test_promotion_refuses_to_replace_a_file_that_appeared(self, tmp_path: Path) -> None:
        candidate = _png(tmp_path / "candidate.jpg")
        target = tmp_path / "target.jpg"
        target.write_bytes(b"someone else's bytes")

        with pytest.raises(ConversionPublicationError, match="refusing to replace"):
            promote_no_clobber(candidate, target)

        assert target.read_bytes() == b"someone else's bytes"
        assert candidate.is_file(), "the candidate must survive a refused promotion"

    def test_promotion_publishes_onto_a_free_name(self, tmp_path: Path) -> None:
        candidate = _png(tmp_path / "candidate.jpg")
        payload = candidate.read_bytes()
        target = tmp_path / "sub" / "target.jpg"

        assert promote_no_clobber(candidate, target) == target
        assert target.read_bytes() == payload
        assert not candidate.exists()

    def test_a_destination_created_after_the_proof_is_not_overwritten(self, tmp_path: Path) -> None:
        """The C-09 window: a file appears between the precheck and the write."""
        published = tmp_path / "lib" / "a.png"
        published.parent.mkdir()
        _png(published)
        store = _store(tmp_path)
        intruder = tmp_path / "lib" / "a.jpg"

        def convert(source: Path) -> Path:
            stage = stage_directory(source, "op1")
            stage.mkdir(parents=True, exist_ok=True)
            candidate = stage / "a.jpg"
            PIL_Image.open(source).convert("RGB").save(candidate)
            # Someone else claims the destination *after* the plan chose it.
            intruder.write_bytes(b"not mine to destroy")
            return candidate

        with pytest.raises(ConversionPublicationError, match="refusing to replace"):
            publish_converted_file(
                published,
                convert=convert,
                expected_suffix=".jpg",
                media="image",
                quarantine=store,
                operation_id="op1",
                final_path=intruder,
            )

        assert intruder.read_bytes() == b"not mine to destroy"
        # The original is not lost — it is in quarantine, recorded and restorable.
        records = store.records()
        assert len(records) == 1
        assert Path(records[0].quarantine_path).is_file()
        assert store.pending_intents() == ()


class TestCrashRecovery:
    def test_a_crash_between_intent_and_record_reports_the_original_as_pending(
        self, tmp_path: Path
    ) -> None:
        """The window `quarantine()` alone cannot close.

        It transfers and *then* appends. A crash in between leaves a file in the
        store that no record mentions — indistinguishable, without the intent
        log, from a file that was never touched.
        """
        published = tmp_path / "lib" / "a.png"
        published.parent.mkdir()
        _png(published)
        store = _store(tmp_path)

        intent = store.declare_intent(published, operation_id="op1", reason="optimization_original")
        # ... process dies here, after the move but before the record lands.
        assert store.pending_intents() == (intent,)
        assert store.records() == ()

        # Recovery can name the original and say honestly that its fate is open.
        pending = store.pending_intents()[0]
        assert pending.original_path == str(published)
        assert pending.state == "pending"
        assert pending.reason == "optimization_original"

    def test_a_committed_intent_whose_record_was_lost_is_still_unresolved(
        self, tmp_path: Path
    ) -> None:
        """A torn write must not read as done."""
        published = tmp_path / "lib" / "a.png"
        published.parent.mkdir()
        _png(published)
        store = _store(tmp_path)

        intent = store.declare_intent(published, operation_id="op1", reason="optimization_original")
        record = store.quarantine(published, operation_id="op1", reason="optimization_original")
        store.commit_intent(intent, record)
        assert store.pending_intents() == ()

        # The record line is lost to a torn write; the intent survives.
        store.records_path.write_text("", encoding="utf-8")
        assert len(store.pending_intents()) == 1
        assert store.pending_intents()[0].record_id == record.record_id

    def test_restarting_after_a_clean_publication_finds_nothing_pending(
        self, tmp_path: Path
    ) -> None:
        published = tmp_path / "lib" / "a.png"
        published.parent.mkdir()
        _png(published)
        store = _store(tmp_path)

        def convert(source: Path) -> Path:
            stage = stage_directory(source, "op1")
            stage.mkdir(parents=True, exist_ok=True)
            candidate = stage / "a.jpg"
            PIL_Image.open(source).convert("RGB").save(candidate)
            return candidate

        publish_converted_file(
            published,
            convert=convert,
            expected_suffix=".jpg",
            media="image",
            quarantine=store,
            operation_id="op1",
        )

        # A fresh reader of the same on-disk state agrees nothing is open.
        reopened = QuarantineStore(store.root)
        assert reopened.pending_intents() == ()
        assert len(reopened.records()) == 1


# ------------------------------------------------------------------ #
# End-to-end: the defect this task exists for                         #
# ------------------------------------------------------------------ #


def _sorting_service(cfg: object) -> object:
    from app.services.config_service import ConfigService
    from app.services.conversion_service import ConversionService
    from app.services.duplicate_service import DuplicateService
    from app.services.extraction_service import DateExtractionService
    from app.services.filesystem_service import FileSystemService
    from app.services.metadata_service import MetadataService
    from app.services.repair_service import RepairService
    from app.services.sorting_service import SortingService

    return SortingService(
        config=cfg,  # type: ignore[arg-type]
        config_service=ConfigService(cfg),  # type: ignore[arg-type]
        filesystem_service=FileSystemService(),
        extraction_service=DateExtractionService(),
        duplicate_service=DuplicateService(),
        metadata_service=MetadataService(),
        conversion_service=ConversionService(),
        repair_service=RepairService(),
        db_manager=None,
    )


@pytest.mark.parametrize(
    "sabotage", ["truncated", "empty"], ids=["truncated candidate", "empty candidate"]
)
def test_a_corrupt_candidate_never_destroys_the_published_original(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch, sabotage: str
) -> None:
    """The C-01 data-loss path, driven through the real sort.

    **This test fails at the pre-task SHA.** The old code ran::

        converted = convert_image(source=dest, ...)
        if converted != dest:
            dest.unlink(missing_ok=True)
            dest = converted

    so a converter that emitted a truncated or empty candidate deleted the
    verified, decodable file and left the wreckage under its name. In move mode
    that file is the user's only copy.
    """
    piexif = pytest.importorskip("piexif")

    from support import authorize_mutations

    from app.core.config import Config
    from app.core.config_fingerprint import config_fingerprint
    from app.core.integrity_policy import authorize_config_mutations
    from app.services.conversion_service import ConversionService
    from app.services.duplicate_service import DuplicateRegistry
    from app.services.operation_execution import OperationExecution

    source_root = tmp_path / "source"
    dest_root = tmp_path / "target"
    source_root.mkdir()
    dest_root.mkdir()

    shot = source_root / "shot.jpg"
    PIL_Image.new("RGB", (40, 40), "blue").save(shot, format="JPEG")
    piexif.insert(
        piexif.dump({"Exif": {piexif.ExifIFD.DateTimeOriginal: b"2024:06:15 12:00:00"}}),
        str(shot),
    )

    cfg = Config(
        source_directory=str(source_root),
        target_directory=str(dest_root),
        sort_criteria=["year", "month", "day"],
        # Move mode: the placed file is the only copy left.
        copy_instead_of_move=False,
        remove_duplicates=False,
        convert_images=True,
        image_format="png",
    )
    authorize_mutations(cfg, conversion=True)

    def sabotaged(
        self: ConversionService,
        source: Path,
        target_format: str,
        quality: int = 90,
        preserve_exif: bool = True,
        output_dir: Path | None = None,
    ) -> Path:
        directory = output_dir or source.parent
        directory.mkdir(parents=True, exist_ok=True)
        candidate = directory / (source.stem + ".png")
        if sabotage == "empty":
            candidate.touch()
        else:
            PIL_Image.new("RGB", (40, 40), "blue").save(candidate, format="PNG")
            whole = candidate.read_bytes()
            candidate.write_bytes(whole[: len(whole) // 4])
        return candidate

    monkeypatch.setattr(ConversionService, "convert_image", sabotaged)

    service = _sorting_service(cfg)
    execution = OperationExecution.start(
        operation_id="op_sabotage",
        state_root=tmp_path / "state",
        preservation=cfg.preservation_profile,
        authorization=authorize_config_mutations(cfg),
        effective_config_sha256=config_fingerprint(cfg),
    )

    record = service._process_file(  # type: ignore[attr-defined]
        file_path=shot,
        source_root=source_root,
        dest_root=dest_root,
        config=cfg,
        dry_run=False,
        registry=DuplicateRegistry(),
        operation_id="op_sabotage",
        execution=execution,
    )

    placed = Path(record["dest_path"])
    assert placed.is_file(), "the run reported a destination that does not exist"

    # The heart of it: whatever was published must still be a whole, decodable
    # image. Before the fix this was the truncated candidate and this fails.
    with PIL_Image.open(placed) as image:
        image.load()
        assert image.size == (40, 40)

    # And the source was moved, not copied, so no second copy is hiding.
    assert not shot.exists()


def test_the_sort_path_holds_no_direct_unlink_of_a_published_destination() -> None:
    """Acceptance (4): the escape hatch is closed, and stays closed.

    A grep rather than a behavioural assertion on purpose — the defect was a
    *shape*, and the next person to reach for `dest.unlink()` on a published
    file should be stopped by a failing test rather than by a code review that
    may not happen.
    """
    source = Path(__file__).resolve().parents[2] / "app" / "services" / "sorting_service.py"
    body = source.read_text(encoding="utf-8")

    assert "dest.unlink" not in body
    # `Path.rename` silently replaces an existing destination (C-09). The
    # publication protocol's no-clobber promotion is the only sanctioned way to
    # move a file onto a planned name.
    assert "dest.rename" not in body
    assert "promote_no_clobber" in body
