"""Tests for hardware probe and encoder factory."""

from __future__ import annotations

from unittest.mock import MagicMock, patch

import pytest

from app.services.ai.hardware import (
    HardwareProfile,
    ModelTier,
    _has_accelerator,
    _recommend_tier,
)

# --------------------------------------------------------------------------- #
# _recommend_tier                                                               #
# --------------------------------------------------------------------------- #


def test_recommend_tier_too_few_cpus() -> None:
    assert _recommend_tier(2, 8.0, False) == "off"


def test_recommend_tier_too_little_ram() -> None:
    assert _recommend_tier(8, 2.0, False) == "off"


def test_recommend_tier_with_accelerator() -> None:
    # Acceleration speeds up the same model; it no longer selects another tier.
    assert _recommend_tier(8, 16.0, True) == "standard"


def test_recommend_tier_standard_cpus() -> None:
    assert _recommend_tier(8, 4.0, False) == "standard"


def test_recommend_tier_standard_ram() -> None:
    assert _recommend_tier(4, 8.0, False) == "standard"


def test_recommend_tier_minimum_machine_runs_the_shipped_model() -> None:
    # 4 CPUs, 4 GB RAM — the old middle "lite" ground now runs SigLIP 2.
    assert _recommend_tier(4, 4.0, False) == "standard"


# --------------------------------------------------------------------------- #
# _has_accelerator                                                              #
# --------------------------------------------------------------------------- #


def test_has_accelerator_cuda() -> None:
    assert _has_accelerator(["CPUExecutionProvider", "CUDAExecutionProvider"])


def test_has_accelerator_coreml() -> None:
    assert _has_accelerator(["CoreMLExecutionProvider"])


def test_has_accelerator_directml_uses_onnx_runtime_identifier() -> None:
    assert _has_accelerator(["CPUExecutionProvider", "DmlExecutionProvider"])
    assert not _has_accelerator(["DirectMLExecutionProvider"])


def test_has_accelerator_cpu_only() -> None:
    assert not _has_accelerator(["CPUExecutionProvider"])


def test_has_accelerator_empty() -> None:
    assert not _has_accelerator([])


# --------------------------------------------------------------------------- #
# HardwareProfile.probe                                                         #
# --------------------------------------------------------------------------- #


def test_probe_returns_profile() -> None:
    with (
        patch("app.services.ai.hardware._ram_gb", return_value=16.0),
        patch("app.services.ai.hardware._onnx_providers", return_value=["CPUExecutionProvider"]),
        patch("os.cpu_count", return_value=8),
    ):
        profile = HardwareProfile.probe()

    assert profile.logical_cpus == 8
    assert profile.total_ram_gb == 16.0
    assert profile.has_accelerator is False
    assert profile.recommended_tier == "standard"
    assert "CPUExecutionProvider" in profile.onnx_providers


def test_probe_detects_accelerator() -> None:
    with (
        patch("app.services.ai.hardware._ram_gb", return_value=32.0),
        patch(
            "app.services.ai.hardware._onnx_providers",
            return_value=["CPUExecutionProvider", "CUDAExecutionProvider"],
        ),
        patch("os.cpu_count", return_value=16),
    ):
        profile = HardwareProfile.probe()

    assert profile.has_accelerator is True
    assert profile.recommended_tier == "standard"


# --------------------------------------------------------------------------- #
# HardwareProfile.effective_tier                                                #
# --------------------------------------------------------------------------- #


@pytest.fixture()
def standard_profile() -> HardwareProfile:
    return HardwareProfile(
        logical_cpus=8,
        total_ram_gb=16.0,
        onnx_providers=["CPUExecutionProvider"],
        has_accelerator=False,
        recommended_tier="standard",
    )


def test_effective_tier_auto(standard_profile: HardwareProfile) -> None:
    assert standard_profile.effective_tier("auto") == "standard"


def test_effective_tier_explicit_off(standard_profile: HardwareProfile) -> None:
    assert standard_profile.effective_tier("off") == "off"


@pytest.mark.parametrize("legacy", ["max", "lite", "MAX", "Lite"])
def test_saved_legacy_tiers_resolve_to_the_shipped_model(
    standard_profile: HardwareProfile, legacy: str
) -> None:
    # Saved settings from releases with Lite/Max keep working (AI-04).
    assert standard_profile.effective_tier(legacy) == "standard"


def test_effective_tier_unknown_falls_back(standard_profile: HardwareProfile) -> None:
    assert standard_profile.effective_tier("turbo") == "standard"


def test_effective_tier_case_insensitive(standard_profile: HardwareProfile) -> None:
    assert standard_profile.effective_tier("STANDARD") == "standard"


# --------------------------------------------------------------------------- #
# build_encoder factory                                                         #
# --------------------------------------------------------------------------- #


def _make_profile(tier: ModelTier = "standard") -> HardwareProfile:
    return HardwareProfile(
        logical_cpus=4,
        total_ram_gb=8.0,
        onnx_providers=["CPUExecutionProvider"],
        has_accelerator=False,
        recommended_tier=tier,
    )


def test_build_encoder_off_returns_none() -> None:
    from app.core.config import Config
    from app.services.ai.encoder_factory import build_encoder

    config = Config(ai_model_tier="off")
    result = build_encoder(config, _make_profile("off"), MagicMock())
    assert result is None


def test_build_encoder_returns_none_when_model_unavailable() -> None:
    from app.core.config import Config
    from app.services.ai.encoder_factory import build_encoder

    config = Config(ai_model_tier="auto")
    profile = _make_profile("standard")
    model_store = MagicMock()
    model_store.component_paths.return_value = None

    with patch("app.services.ai.siglip_encoder.SiglipOnnxEncoder") as constructor:
        result = build_encoder(config, profile, model_store)

    assert result is None
    constructor.assert_not_called()


@pytest.mark.parametrize("tier", ["standard", "max", "lite"])
def test_every_saved_tier_builds_the_same_siglip_encoder(tier: str) -> None:
    from app.core.config import Config
    from app.services.ai.encoder_factory import build_encoder
    from app.services.ai.siglip_encoder import SiglipOnnxEncoder

    mock_siglip = MagicMock(spec=SiglipOnnxEncoder)
    mock_siglip.model_id = "siglip2-base-patch16-256"
    model_store = MagicMock()
    model_store.component_paths.return_value = {
        "vision": MagicMock(),
        "text": MagicMock(),
        "tokenizer": MagicMock(),
    }

    config = Config(ai_model_tier=tier)
    profile = _make_profile("standard")

    with patch(
        "app.services.ai.siglip_encoder.SiglipOnnxEncoder", return_value=mock_siglip
    ) as constructor:
        result = build_encoder(config, profile, model_store)

    assert result is mock_siglip
    constructor.assert_called_once_with(allow_gpu=True, model_store=model_store)


def test_build_encoder_standard_does_not_silently_fall_back_to_another_pack() -> None:
    from app.core.config import Config
    from app.services.ai.encoder_factory import build_encoder

    config = Config(ai_model_tier="standard")
    profile = _make_profile("standard")
    model_store = MagicMock()
    model_store.component_paths.return_value = None

    with patch("app.services.ai.siglip_encoder.SiglipOnnxEncoder") as siglip:
        result = build_encoder(config, profile, model_store)

    assert result is None
    siglip.assert_not_called()
