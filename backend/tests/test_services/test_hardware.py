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
    assert _recommend_tier(8, 16.0, True) == "max"


def test_recommend_tier_standard_cpus() -> None:
    assert _recommend_tier(8, 4.0, False) == "standard"


def test_recommend_tier_standard_ram() -> None:
    assert _recommend_tier(4, 8.0, False) == "standard"


def test_recommend_tier_lite() -> None:
    # 4 CPUs, 4 GB RAM, no accelerator — middle ground → lite
    assert _recommend_tier(4, 4.0, False) == "lite"


# --------------------------------------------------------------------------- #
# _has_accelerator                                                              #
# --------------------------------------------------------------------------- #


def test_has_accelerator_cuda() -> None:
    assert _has_accelerator(["CPUExecutionProvider", "CUDAExecutionProvider"])


def test_has_accelerator_coreml() -> None:
    assert _has_accelerator(["CoreMLExecutionProvider"])


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
    assert profile.recommended_tier == "max"


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


def test_effective_tier_explicit_max(standard_profile: HardwareProfile) -> None:
    # Should warn but honour the request
    assert standard_profile.effective_tier("max") == "max"


def test_effective_tier_unknown_falls_back(standard_profile: HardwareProfile) -> None:
    assert standard_profile.effective_tier("turbo") == "standard"


def test_effective_tier_case_insensitive(standard_profile: HardwareProfile) -> None:
    assert standard_profile.effective_tier("LITE") == "lite"


# --------------------------------------------------------------------------- #
# build_encoder factory                                                         #
# --------------------------------------------------------------------------- #


def _make_profile(tier: ModelTier = "lite") -> HardwareProfile:
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
    result = build_encoder(config, _make_profile("off"))
    assert result is None


def test_build_encoder_lite_returns_encoder_when_available() -> None:
    from app.core.config import Config
    from app.services.ai.clip_embedder import ClipEmbedder
    from app.services.ai.encoder_factory import build_encoder

    mock_encoder = MagicMock(spec=ClipEmbedder)
    mock_encoder.available = True
    mock_encoder.model_id = "clip-vit-b-32"

    config = Config(ai_model_tier="auto")
    profile = _make_profile("lite")

    with patch("app.services.ai.encoder_factory.ClipEmbedder", return_value=mock_encoder):
        result = build_encoder(config, profile)

    assert result is mock_encoder


def test_build_encoder_returns_none_when_model_unavailable() -> None:
    from app.core.config import Config
    from app.services.ai.clip_embedder import ClipEmbedder
    from app.services.ai.encoder_factory import build_encoder

    mock_encoder = MagicMock(spec=ClipEmbedder)
    mock_encoder.available = False

    config = Config(ai_model_tier="auto")
    profile = _make_profile("lite")

    with patch("app.services.ai.encoder_factory.ClipEmbedder", return_value=mock_encoder):
        result = build_encoder(config, profile)

    assert result is None


def test_build_encoder_standard_uses_siglip_when_available() -> None:
    from app.core.config import Config
    from app.services.ai.encoder_factory import build_encoder
    from app.services.ai.siglip_encoder import SiglipOnnxEncoder

    mock_siglip = MagicMock(spec=SiglipOnnxEncoder)
    mock_siglip.available = True
    mock_siglip.model_id = "siglip2-base-patch16-256"

    config = Config(ai_model_tier="standard")
    profile = _make_profile("standard")

    with patch("app.services.ai.siglip_encoder.SiglipOnnxEncoder", return_value=mock_siglip):
        result = build_encoder(config, profile)

    assert result is mock_siglip


def test_build_encoder_standard_falls_back_to_clip_when_siglip_unavailable() -> None:
    from app.core.config import Config
    from app.services.ai.clip_embedder import ClipEmbedder
    from app.services.ai.encoder_factory import build_encoder
    from app.services.ai.siglip_encoder import SiglipOnnxEncoder

    mock_siglip = MagicMock(spec=SiglipOnnxEncoder)
    mock_siglip.available = False  # e.g. onnxruntime/weights missing, offline

    mock_clip = MagicMock(spec=ClipEmbedder)
    mock_clip.available = True
    mock_clip.model_id = "clip-vit-b-32"

    config = Config(ai_model_tier="standard")
    profile = _make_profile("standard")

    with (
        patch("app.services.ai.siglip_encoder.SiglipOnnxEncoder", return_value=mock_siglip),
        patch("app.services.ai.encoder_factory.ClipEmbedder", return_value=mock_clip),
    ):
        result = build_encoder(config, profile)

    assert result is mock_clip
