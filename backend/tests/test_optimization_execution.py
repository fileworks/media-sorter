"""Nothing replaces an original until the replacement has proven itself."""

from __future__ import annotations

import dataclasses
from pathlib import Path
from typing import Any

import pytest

from app.core.integrity import OptimizationProfile, utc_now
from app.core.optimization_contracts import (
    CONTRACTS,
    FormatContract,
    discover_tool,
)
from app.core.optimization_contracts import (
    contract as load_contract,
)
from app.services.optimization_encoders import EncodeAttempt
from app.services.optimization_execution import (
    OptimizationBlocked,
    optimize_file,
    outcome_to_action,
    preflight,
)
from app.services.quarantine import QuarantineStore, store_for_state_root

PNG_CONTRACT = "image-png-lossless-v1"


@pytest.fixture()
def validated_png(monkeypatch: pytest.MonkeyPatch) -> FormatContract:
    """A promoted copy of the PNG contract, so execution paths are reachable.

    Contracts ship as ``declared`` on purpose; promoting one inside a test is the
    only way to exercise what a future promotion would enable, and it keeps the
    real registry untouched.
    """
    promoted = dataclasses.replace(load_contract(PNG_CONTRACT), status="validated")
    monkeypatch.setitem(CONTRACTS, PNG_CONTRACT, promoted)
    return promoted


@pytest.fixture()
def profile(validated_png: FormatContract) -> OptimizationProfile:
    return OptimizationProfile(
        profile_id=PNG_CONTRACT,
        name="Lossless — png",
        mode="lossless",
        acknowledged_at=utc_now(),
        tool="pillow",
        # The installed version, because preflight refuses a plan that was
        # projected with a different encoder build.
        tool_version=discover_tool("pillow").version or "unknown",
        validation_contract=PNG_CONTRACT,
    )


@pytest.fixture()
def quarantine(tmp_path: Path) -> QuarantineStore:
    return store_for_state_root(tmp_path / "state")


def _png(path: Path, *, size: tuple[int, int] = (48, 32)) -> Path:
    from PIL import Image

    image = Image.new("RGB", size, (10, 20, 30))
    for x in range(0, size[0], 2):
        for y in range(0, size[1], 3):
            image.putpixel((x, y), ((x * 5) % 256, (y * 11) % 256, 128))
    path.parent.mkdir(parents=True, exist_ok=True)
    image.save(path, compress_level=0)
    return path


@dataclasses.dataclass
class _Encoder:
    """Encoder whose result and self-reported measurements are controllable."""

    contract: FormatContract
    measurements: dict[str, object] = dataclasses.field(
        default_factory=lambda: {
            "decoded_pixels_identical": True,
            "dimensions_identical": True,
            "size_reduction_ratio": 0.4,
        }
    )
    error: str | None = None
    write_garbage: bool = False

    def supports(self, path: Path) -> bool:
        return True

    def encode(self, source: Path, destination: Path) -> EncodeAttempt:
        source_bytes = source.stat().st_size
        if self.error is not None:
            return EncodeAttempt(self.contract.contract_id, source, source_bytes, error=self.error)
        destination.parent.mkdir(parents=True, exist_ok=True)
        if self.write_garbage:
            destination.write_bytes(b"not an image")
        else:
            from PIL import Image

            with Image.open(source) as image:
                image.save(destination, optimize=True, compress_level=9)
        return EncodeAttempt(
            contract_id=self.contract.contract_id,
            source_path=source,
            source_bytes=source_bytes,
            candidate_path=destination,
            candidate_bytes=destination.stat().st_size,
            measurements=dict(self.measurements),
        )


def _optimize(
    source: Path,
    *,
    profile: OptimizationProfile,
    contract: FormatContract,
    encoder: _Encoder,
    quarantine: QuarantineStore,
    tmp_path: Path,
    destination: Path | None = None,
) -> Any:
    return optimize_file(
        source,
        profile=profile,
        contract=contract,
        encoder=encoder,
        state_root=tmp_path / "state",
        quarantine=quarantine,
        operation_id="op-test",
        destination=destination,
    )


class TestPreflight:
    def test_disabled_profile_is_refused(self, tmp_path: Path) -> None:
        with pytest.raises(OptimizationBlocked):
            preflight(OptimizationProfile(), [tmp_path / "a.png"])

    def test_unvalidated_contract_is_refused(self, tmp_path: Path) -> None:
        unvalidated = OptimizationProfile(
            profile_id="video-remux-lossless-v1",
            name="Lossless — copy",
            mode="lossless",
            acknowledged_at=utc_now(),
            tool="ffmpeg",
            tool_version="test",
            validation_contract="video-remux-lossless-v1",
        )

        with pytest.raises(OptimizationBlocked, match="declared"):
            preflight(unvalidated, [tmp_path / "a.mov"])

    def test_unsupported_input_blocks_before_any_original_is_touched(
        self, profile: OptimizationProfile, tmp_path: Path
    ) -> None:
        source = _png(tmp_path / "a.png")

        with pytest.raises(OptimizationBlocked, match="not covered"):
            preflight(profile, [source, tmp_path / "clip.mov"])
        assert source.is_file()

    def test_a_different_installed_encoder_invalidates_the_plan(
        self, validated_png: FormatContract, tmp_path: Path
    ) -> None:
        stale = OptimizationProfile(
            profile_id=PNG_CONTRACT,
            name="Lossless — png",
            mode="lossless",
            acknowledged_at=utc_now(),
            tool="pillow",
            tool_version="0.0.1-not-installed",
            validation_contract=PNG_CONTRACT,
        )

        with pytest.raises(OptimizationBlocked, match="differs"):
            preflight(stale, [_png(tmp_path / "a.png")])


class TestStagedOptimization:
    def test_accepted_output_commits_and_quarantines_the_original(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")
        original_bytes = source.read_bytes()
        destination = tmp_path / "library" / "photo.optimized.png"

        outcome = _optimize(
            source,
            profile=profile,
            contract=validated_png,
            encoder=_Encoder(validated_png),
            quarantine=quarantine,
            tmp_path=tmp_path,
            destination=destination,
        )

        assert outcome.code == "optimized"
        assert destination.is_file()
        assert outcome.quality is not None and outcome.quality.passed is True
        assert outcome.quarantine_record is not None
        assert Path(outcome.quarantine_record.quarantine_path).read_bytes() == original_bytes
        assert outcome.quarantine_record.keeper_path == str(destination)

    def test_a_rejected_result_leaves_the_original_exactly_where_it_was(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")
        before = source.read_bytes()
        encoder = _Encoder(validated_png)
        encoder.measurements["decoded_pixels_identical"] = False

        outcome = _optimize(
            source,
            profile=profile,
            contract=validated_png,
            encoder=encoder,
            quarantine=quarantine,
            tmp_path=tmp_path,
        )

        assert outcome.code == "rejected"
        assert source.read_bytes() == before
        assert quarantine.records() == ()

    def test_an_unmeasured_threshold_is_indeterminate_not_a_pass(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")
        encoder = _Encoder(validated_png)
        del encoder.measurements["size_reduction_ratio"]

        outcome = _optimize(
            source,
            profile=profile,
            contract=validated_png,
            encoder=encoder,
            quarantine=quarantine,
            tmp_path=tmp_path,
        )

        assert outcome.code == "indeterminate"
        assert outcome.quality is not None and outcome.quality.passed is None
        assert source.is_file()

    def test_an_undecodable_output_is_rejected_even_when_the_encoder_claims_success(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")

        outcome = _optimize(
            source,
            profile=profile,
            contract=validated_png,
            encoder=_Encoder(validated_png, write_garbage=True),
            quarantine=quarantine,
            tmp_path=tmp_path,
        )

        assert outcome.code == "rejected"
        assert outcome.quality is not None and outcome.quality.decoded_successfully is False
        assert source.is_file()

    def test_encoder_failure_is_an_outcome_not_an_exception(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")

        outcome = _optimize(
            source,
            profile=profile,
            contract=validated_png,
            encoder=_Encoder(validated_png, error="no encoder here"),
            quarantine=quarantine,
            tmp_path=tmp_path,
        )

        assert outcome.code == "failed"
        assert outcome.source_safe
        assert source.is_file()

    def test_staging_never_survives_the_call(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")

        _optimize(
            source,
            profile=profile,
            contract=validated_png,
            encoder=_Encoder(validated_png),
            quarantine=quarantine,
            tmp_path=tmp_path,
        )

        staging = tmp_path / "state" / "optimize-stage"
        assert not staging.exists() or not any(staging.iterdir())

    def test_temporary_space_limit_skips_before_encoding(
        self,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")
        tight = OptimizationProfile(
            profile_id=PNG_CONTRACT,
            name="Lossless — png",
            mode="lossless",
            acknowledged_at=utc_now(),
            tool="pillow",
            tool_version=discover_tool("pillow").version or "unknown",
            validation_contract=PNG_CONTRACT,
            temporary_space_limit_bytes=1,
        )

        outcome = _optimize(
            source,
            profile=tight,
            contract=validated_png,
            encoder=_Encoder(validated_png),
            quarantine=quarantine,
            tmp_path=tmp_path,
        )

        assert outcome.code == "skipped"
        assert outcome.diagnostic_code == "temporary_space_limit"

    def test_the_original_can_be_restored_after_an_accepted_optimization(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        source = _png(tmp_path / "library" / "photo.png")
        before = source.read_bytes()
        outcome = _optimize(
            source,
            profile=profile,
            contract=validated_png,
            encoder=_Encoder(validated_png),
            quarantine=quarantine,
            tmp_path=tmp_path,
            destination=tmp_path / "library" / "photo.opt.png",
        )
        assert outcome.quarantine_record is not None

        quarantine.restore(outcome.quarantine_record)

        assert source.read_bytes() == before


class TestOutcomeProjection:
    def test_optimized_outcome_reports_redundant_verified_copies(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        outcome = _optimize(
            _png(tmp_path / "library" / "photo.png"),
            profile=profile,
            contract=validated_png,
            encoder=_Encoder(validated_png),
            quarantine=quarantine,
            tmp_path=tmp_path,
            destination=tmp_path / "library" / "photo.opt.png",
        )

        action = outcome_to_action(outcome)

        assert action.code == "verified_success"
        assert action.source_safety == "redundant_verified_copies"
        assert action.quality is not None

    def test_rejected_outcome_never_claims_success(
        self,
        profile: OptimizationProfile,
        validated_png: FormatContract,
        quarantine: QuarantineStore,
        tmp_path: Path,
    ) -> None:
        encoder = _Encoder(validated_png)
        encoder.measurements["dimensions_identical"] = False

        action = outcome_to_action(
            _optimize(
                _png(tmp_path / "library" / "photo.png"),
                profile=profile,
                contract=validated_png,
                encoder=encoder,
                quarantine=quarantine,
                tmp_path=tmp_path,
            )
        )

        assert action.code == "skipped"
        assert action.result_path is None
        assert action.source_safety == "source_retained"
