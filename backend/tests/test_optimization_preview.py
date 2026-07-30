"""Projections must never look more certain than the encodes behind them."""

from __future__ import annotations

import dataclasses
from pathlib import Path

import pytest

from app.core.optimization_contracts import contract as load_contract
from app.services.optimization_encoders import EncodeAttempt, PillowImageEncoder
from app.services.optimization_preview import (
    PreviewItem,
    project_optimization,
    select_samples,
)

PNG_CONTRACT = "image-png-lossless-v1"


def _png(path: Path, *, size: tuple[int, int] = (64, 48), colour: int = 0) -> Path:
    from PIL import Image

    image = Image.new("RGB", size, (colour % 256, 40, 90))
    # Noise keeps the file from compressing to nothing, so ratios stay meaningful.
    for x in range(0, size[0], 3):
        for y in range(0, size[1], 2):
            image.putpixel((x, y), ((x * 7 + colour) % 256, (y * 13) % 256, 200))
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, compress_level=0)
    return path


@dataclasses.dataclass
class _StubEncoder:
    """An encoder with a fixed ratio, so projections can be asserted exactly."""

    contract: object
    ratio: float = 0.5
    fail: bool = False
    pixels_identical: bool = True

    def supports(self, path: Path) -> bool:
        return True

    def encode(self, source: Path, destination: Path) -> EncodeAttempt:
        source_bytes = source.stat().st_size
        if self.fail:
            return EncodeAttempt(
                self.contract.contract_id, source, source_bytes, error="encoder unavailable"
            )
        destination.parent.mkdir(parents=True, exist_ok=True)
        candidate_bytes = max(int(source_bytes * (1 - self.ratio)), 1)
        destination.write_bytes(b"\0" * candidate_bytes)
        return EncodeAttempt(
            contract_id=self.contract.contract_id,
            source_path=source,
            source_bytes=source_bytes,
            candidate_path=destination,
            candidate_bytes=candidate_bytes,
            measurements={
                "decoded_pixels_identical": self.pixels_identical,
                "dimensions_identical": True,
                "size_reduction_ratio": self.ratio,
            },
        )


class TestSampleSelection:
    def test_sample_is_bounded_and_size_stratified(self, tmp_path: Path) -> None:
        items = [PreviewItem(tmp_path / f"{index}.png", 1000 * (index + 1)) for index in range(10)]

        plan = select_samples(items, max_samples=3)

        assert len(plan.items) == 3
        assert [item.size_bytes for item in plan.items] == [1000, 5000, 10000]

    def test_items_above_the_item_limit_are_excluded_with_a_reason(self, tmp_path: Path) -> None:
        items = [
            PreviewItem(tmp_path / "small.png", 1_000),
            PreviewItem(tmp_path / "huge.png", 900 * 1024 * 1024),
        ]

        plan = select_samples(items, max_item_bytes=1024 * 1024)

        assert [item.path.name for item in plan.items] == ["small.png"]
        assert any("sample limit" in reason for reason in plan.excluded)

    def test_selection_is_deterministic_for_equal_sizes(self, tmp_path: Path) -> None:
        items = [PreviewItem(tmp_path / name, 100) for name in ("c.png", "a.png", "b.png")]

        first = select_samples(items, max_samples=2)
        second = select_samples(list(reversed(items)), max_samples=2)

        assert [item.path for item in first.items] == [item.path for item in second.items]

    def test_no_eligible_item_reports_why_rather_than_sampling_nothing(
        self, tmp_path: Path
    ) -> None:
        plan = select_samples([PreviewItem(tmp_path / "big.png", 10_000)], max_item_bytes=1_000)

        assert plan.items == ()
        assert plan.skipped_reason is not None


class TestProjection:
    def test_sampled_item_is_measured_and_the_rest_are_a_range(self, tmp_path: Path) -> None:
        items = [PreviewItem(_png(tmp_path / f"{i}.png", colour=i * 20), 0) for i in range(4)]
        items = [PreviewItem(item.path, item.path.stat().st_size) for item in items]
        encoder = _StubEncoder(load_contract(PNG_CONTRACT), ratio=0.5)

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=encoder,
            workspace=tmp_path / "work",
            max_samples=1,
        )

        measured = [item for item in projection.items if item.confidence == "measured"]
        sampled = [item for item in projection.items if item.confidence == "sampled"]
        assert len(measured) == 1
        assert len(sampled) == 3
        assert measured[0].projected_low_bytes == measured[0].projected_high_bytes
        assert all(item.projected_low_bytes < item.projected_high_bytes for item in sampled)

    def test_aggregate_reports_temporary_and_quarantine_space(self, tmp_path: Path) -> None:
        items = [
            PreviewItem(path, path.stat().st_size)
            for path in (_png(tmp_path / "a.png"), _png(tmp_path / "b.png", colour=90))
        ]

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=_StubEncoder(load_contract(PNG_CONTRACT)),
            workspace=tmp_path / "work",
        )

        assert projection.quarantine_space_bytes == sum(item.size_bytes for item in items)
        assert projection.temporary_space_bytes >= max(item.size_bytes for item in items)
        assert projection.output_container == "png"
        assert projection.mode == "lossless"

    def test_failed_sampling_yields_unknown_confidence_not_a_number(self, tmp_path: Path) -> None:
        items = [PreviewItem(path, path.stat().st_size) for path in (_png(tmp_path / "a.png"),)]

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=_StubEncoder(load_contract(PNG_CONTRACT), fail=True),
            workspace=tmp_path / "work",
        )

        assert projection.confidence == "unknown"
        assert projection.estimated_saving_bytes is None
        assert projection.recommended_count == 0
        assert projection.failures and "encoder unavailable" in projection.failures[0]

    def test_projected_growth_recommends_skipping(self, tmp_path: Path) -> None:
        items = [PreviewItem(path, path.stat().st_size) for path in (_png(tmp_path / "a.png"),)]

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=_StubEncoder(load_contract(PNG_CONTRACT), ratio=-0.4),
            workspace=tmp_path / "work",
        )

        assert projection.recommended_count == 0
        assert projection.skipped_count == 1
        assert "larger" in projection.items[0].reason

    def test_sample_that_breaks_its_contract_blocks_the_item(self, tmp_path: Path) -> None:
        items = [PreviewItem(path, path.stat().st_size) for path in (_png(tmp_path / "a.png"),)]
        encoder = _StubEncoder(load_contract(PNG_CONTRACT), ratio=0.5)
        encoder.pixels_identical = False

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=encoder,
            workspace=tmp_path / "work",
        )

        assert projection.blocked_count == 1
        assert projection.samples[0].quality.passed is False

    def test_unsupported_formats_are_blocked_rather_than_estimated(self, tmp_path: Path) -> None:
        movie = tmp_path / "clip.mov"
        movie.write_bytes(b"not really a movie")

        projection = project_optimization(
            [PreviewItem(movie, movie.stat().st_size)],
            PNG_CONTRACT,
            encoder=_StubEncoder(load_contract(PNG_CONTRACT)),
            workspace=tmp_path / "work",
        )

        assert projection.blocked_count == 1
        assert projection.confidence == "unknown"

    def test_without_a_workspace_numbers_survive_but_candidates_do_not(
        self, tmp_path: Path
    ) -> None:
        items = [PreviewItem(path, path.stat().st_size) for path in (_png(tmp_path / "a.png"),)]

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=_StubEncoder(load_contract(PNG_CONTRACT)),
        )

        assert projection.estimate_only is True
        assert projection.samples and projection.samples[0].candidate_path is None
        assert projection.items[0].confidence == "measured"

    def test_generated_sample_is_comparable_when_retained(self, tmp_path: Path) -> None:
        items = [PreviewItem(path, path.stat().st_size) for path in (_png(tmp_path / "a.png"),)]

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=_StubEncoder(load_contract(PNG_CONTRACT)),
            workspace=tmp_path / "work",
        )

        assert projection.estimate_only is False
        sample = projection.samples[0]
        assert sample.comparable and sample.candidate_path is not None
        assert sample.sampling_scope == "whole file"
        assert sample.quality.thresholds  # the contract's own numbers travel with it

    def test_every_projection_carries_the_contract_facts_the_ui_must_show(
        self, tmp_path: Path
    ) -> None:
        items = [PreviewItem(path, path.stat().st_size) for path in (_png(tmp_path / "a.png"),)]

        projection = project_optimization(
            items,
            PNG_CONTRACT,
            encoder=_StubEncoder(load_contract(PNG_CONTRACT)),
            workspace=tmp_path / "work",
        )
        item = projection.items[0]

        assert item.output_codec == "png"
        assert "compress_level" in item.quality_setting
        assert "size_reduction_ratio" in item.validation_method
        assert item.compatibility_warnings


class TestRealPillowEncoder:
    """The one encoder that ships enabled must actually prove its claim."""

    def test_recompression_keeps_every_decoded_pixel(self, tmp_path: Path) -> None:
        source = _png(tmp_path / "photo.png")
        encoder = PillowImageEncoder(load_contract(PNG_CONTRACT))

        attempt = encoder.encode(source, tmp_path / "out" / "photo.png")

        assert attempt.produced_candidate
        assert attempt.measurements["decoded_pixels_identical"] is True
        assert attempt.measurements["dimensions_identical"] is True

    def test_unreadable_source_fails_without_leaving_a_candidate(self, tmp_path: Path) -> None:
        source = tmp_path / "broken.png"
        source.write_bytes(b"\x89PNG\r\n\x1a\n truncated")
        destination = tmp_path / "out" / "broken.png"

        attempt = PillowImageEncoder(load_contract(PNG_CONTRACT)).encode(source, destination)

        assert not attempt.produced_candidate
        assert attempt.error is not None
        assert not destination.exists()


@pytest.mark.parametrize("contract_id", ["image-png-lossless-v1", "video-remux-lossless-v1"])
def test_contract_facts_are_complete_enough_to_render(contract_id: str) -> None:
    declared = load_contract(contract_id)

    assert declared.metrics
    assert declared.decoded_content
    assert declared.metadata_policy
