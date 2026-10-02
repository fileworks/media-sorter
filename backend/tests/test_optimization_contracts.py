"""The optimizer gate: no format may be optimized before it is validated.

These tests exist to make the gate hard to open by accident. A contract that
quietly flips to ``validated``, or a profile that materializes without an
acknowledgement or a working tool, would let lossy re-encoding reach real media.
"""

from __future__ import annotations

import pytest

from app.core.optimization_contracts import (
    CONTRACTS,
    OptimizationUnavailableError,
    build_optimization_profile,
    contract,
    discover_tool,
    enabled_contracts,
)


def test_no_contract_is_enabled_until_its_fixtures_pass() -> None:
    assert enabled_contracts() == (), (
        "A contract was promoted to validated. That is only legitimate together "
        "with a curated-fixture and interruption run for the same format."
    )


def test_every_contract_declares_what_it_promises_and_how_it_is_measured() -> None:
    for contract_id, declared in CONTRACTS.items():
        assert declared.contract_id == contract_id
        assert declared.source_formats, f"{contract_id} names no input formats"
        assert declared.decoded_content.strip(), f"{contract_id} does not say what it preserves"
        assert declared.metadata_policy.strip(), f"{contract_id} has no metadata policy"
        assert declared.metrics, f"{contract_id} has no acceptance measurements"
        assert declared.minimum_tool_version, f"{contract_id} pins no tool version"
        for metric in declared.metrics:
            assert metric.rationale.strip(), f"{contract_id}:{metric.name} has no rationale"


def test_a_lossless_contract_claims_identical_decoded_content() -> None:
    for declared in CONTRACTS.values():
        if declared.mode != "lossless":
            continue
        measured = {metric.name for metric in declared.metrics}
        assert measured & {
            "decoded_pixels_identical",
            "stream_count_identical",
        }, f"{declared.contract_id} claims lossless without measuring identity"


def test_a_visually_lossless_contract_never_claims_perceptual_identity() -> None:
    for declared in CONTRACTS.values():
        if declared.mode != "visually_lossless":
            continue
        assert "lossy" in declared.decoded_content.lower()
        assert "never that a person" in declared.decoded_content
        assert declared.compatibility_warnings, (
            f"{declared.contract_id} re-encodes lossily and must state its costs"
        )


def test_lossy_contracts_require_a_worthwhile_saving() -> None:
    lossy = [item for item in CONTRACTS.values() if item.mode == "visually_lossless"]
    assert lossy
    for declared in lossy:
        savings = [m for m in declared.metrics if m.name == "size_reduction_ratio"]
        assert savings, f"{declared.contract_id} does not require any saving"
        assert savings[0].threshold >= 0.25  # type: ignore[operator]


def test_a_declared_contract_cannot_produce_a_runnable_profile() -> None:
    with pytest.raises(OptimizationUnavailableError, match="has not passed its validation"):
        build_optimization_profile("video-remux-lossless-v1", acknowledged=True)


def test_a_blocked_contract_stays_blocked() -> None:
    assert contract("image-jpeg-lossless-transcode-v1").status == "blocked"
    with pytest.raises(OptimizationUnavailableError):
        build_optimization_profile("image-jpeg-lossless-transcode-v1", acknowledged=True)


def test_an_unknown_contract_is_refused_rather_than_defaulted() -> None:
    with pytest.raises(OptimizationUnavailableError, match="Unknown contract"):
        contract("video-magic-v9")


def test_acknowledgement_is_checked_even_for_a_validated_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    validated = contract("video-remux-lossless-v1").__class__(
        **{**vars(contract("video-remux-lossless-v1")), "status": "validated"}
    )
    monkeypatch.setitem(CONTRACTS, "video-remux-lossless-v1", validated)

    with pytest.raises(OptimizationUnavailableError, match="requires an explicit acknowledgement"):
        build_optimization_profile("video-remux-lossless-v1", acknowledged=False)


def test_a_missing_tool_blocks_a_validated_acknowledged_contract(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core import optimization_contracts

    original = contract("video-remux-lossless-v1")
    validated = original.__class__(**{**vars(original), "status": "validated"})
    monkeypatch.setitem(CONTRACTS, "video-remux-lossless-v1", validated)
    monkeypatch.setattr(
        optimization_contracts,
        "discover_tool",
        lambda tool: optimization_contracts.ToolCapability(tool, False, detail="not on PATH"),
    )

    with pytest.raises(OptimizationUnavailableError, match="unavailable"):
        build_optimization_profile("video-remux-lossless-v1", acknowledged=True)


def test_a_built_profile_is_reproducible_and_retains_the_original(
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.core import optimization_contracts

    original = contract("video-remux-lossless-v1")
    validated = original.__class__(**{**vars(original), "status": "validated"})
    monkeypatch.setitem(CONTRACTS, "video-remux-lossless-v1", validated)
    monkeypatch.setattr(
        optimization_contracts,
        "discover_tool",
        lambda tool: optimization_contracts.ToolCapability(tool, True, version="ffmpeg 7.1"),
    )

    profile = build_optimization_profile(
        "video-remux-lossless-v1",
        acknowledged=True,
        memory_limit_mib=256,
        temporary_space_limit_bytes=1024,
    )

    assert profile.mode == "lossless"
    assert profile.tool == "ffmpeg"
    assert profile.tool_version == "ffmpeg 7.1"
    assert profile.validation_contract == "video-remux-lossless-v1"
    assert profile.parameters == dict(original.parameters)
    assert profile.retain_original is True
    assert profile.acknowledged_at is not None


def test_tool_discovery_reports_absence_without_raising() -> None:
    capability = discover_tool("definitely-not-a-real-tool")

    assert capability.available is False
    assert capability.detail == "not on PATH"
