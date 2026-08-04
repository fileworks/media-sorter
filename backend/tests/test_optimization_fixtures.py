"""The gate that decides whether a format may be optimized at all.

A contract is allowed to move from ``declared`` to ``validated`` only if it
survives this file: every curated fixture — ordinary, tiny, animated, high bit
depth, metadata-bearing, and corrupt — must either meet the declared thresholds
or be refused outright. Nothing here promotes a contract; it fails the build if
one was promoted without the evidence.

The fixtures are generated, not committed, so the corpus stays reviewable and
the repository stays small.
"""

from __future__ import annotations

import dataclasses
from collections.abc import Iterator
from pathlib import Path
from typing import Any

import pytest

from app.core.optimization_contracts import (
    CONTRACTS,
    FormatContract,
    discover_tool,
    enabled_contracts,
)
from app.services.optimization_encoders import (
    EncoderUnavailableError,
    encoder_for,
    evaluate_metrics,
)


@dataclasses.dataclass(frozen=True)
class Fixture:
    """One curated input and what the contract is expected to do with it."""

    name: str
    path: Path
    #: ``True`` when a validated contract must produce a passing result;
    #: ``False`` when it must refuse rather than produce anything.
    must_pass: bool
    note: str


def _image_fixtures(root: Path) -> Iterator[Fixture]:
    from PIL import Image, PngImagePlugin

    root.mkdir(parents=True, exist_ok=True)

    ordinary = root / "ordinary.png"
    image = Image.new("RGB", (96, 64), (12, 34, 56))
    for x in range(0, 96, 2):
        for y in range(0, 64, 3):
            image.putpixel((x, y), ((x * 3) % 256, (y * 7) % 256, 180))
    image.save(ordinary, compress_level=0)
    yield Fixture("ordinary", ordinary, True, "a normal photo-like image")

    tiny = root / "tiny.png"
    # Already saved at maximum compression: there is nothing left to win, and a
    # lossless contract must decline rather than rewrite a file for nothing.
    Image.new("RGB", (1, 1), (255, 0, 0)).save(tiny, optimize=True, compress_level=9)
    yield Fixture("tiny", tiny, False, "a 1x1 image that cannot meet the size threshold")

    alpha = root / "alpha.png"
    Image.new("RGBA", (32, 32), (0, 0, 255, 128)).save(alpha, optimize=True, compress_level=9)
    yield Fixture("alpha", alpha, False, "already-optimal alpha image below the size threshold")

    deep = root / "high-bit-depth.png"
    Image.new("I;16", (64, 64), 40_000).save(deep, compress_level=0)
    yield Fixture("high_bit_depth", deep, False, "16-bit source; depth must survive or be refused")

    metadata = root / "metadata.png"
    info = PngImagePlugin.PngInfo()
    info.add_text("Description", "curated fixture")
    info.add_text("Copyright", "fileworks")
    Image.new("RGB", (64, 64), (200, 100, 50)).save(metadata, pnginfo=info, compress_level=0)
    yield Fixture("metadata", metadata, False, "textual chunks must not be silently dropped")

    animated = root / "animated.gif"
    frames = [Image.new("P", (32, 32), colour) for colour in (1, 2, 3)]
    frames[0].save(animated, save_all=True, append_images=frames[1:], duration=80, loop=0)
    yield Fixture("animated", animated, False, "multi-frame source outside the PNG contract")

    corrupt = root / "corrupt.png"
    corrupt.write_bytes(b"\x89PNG\r\n\x1a\n" + b"\x00" * 32)
    yield Fixture("corrupt", corrupt, False, "truncated file must fail, never half-convert")


def curated_fixtures(root: Path, contract: FormatContract) -> tuple[Fixture, ...]:
    if contract.media_kind == "image":
        return tuple(_image_fixtures(root))
    return ()


def run_contract(
    contract: FormatContract, fixtures: tuple[Fixture, ...], workspace: Path
) -> list[Any]:
    """Encode every fixture and report what each one proved."""
    encoder = encoder_for(contract)
    results = []
    for fixture in fixtures:
        if fixture.path.suffix.lower() not in contract.source_formats:
            results.append((fixture, None))
            continue
        attempt = encoder.encode(
            fixture.path, workspace / f"{fixture.name}.{contract.output_container}"
        )
        if not attempt.produced_candidate:
            results.append((fixture, None))
            continue
        evidence = evaluate_metrics(
            contract,
            attempt.measurements,
            decoded_successfully=True,
            sampling_scope="whole file",
            warnings=attempt.warnings,
        )
        results.append((fixture, evidence))  # type: ignore[arg-type]
    return results


class TestReleaseGate:
    def test_no_contract_is_enabled_without_fixture_evidence(self, tmp_path: Path) -> None:
        """Every ``validated`` contract must pass its curated corpus, here, now.

        This is the release gate. It is trivially satisfied while the registry
        ships nothing validated, and it becomes the real check the moment one is
        promoted — which is exactly when it needs to exist.
        """
        for contract in enabled_contracts():
            fixtures = curated_fixtures(tmp_path / contract.contract_id, contract)
            assert fixtures, f"{contract.contract_id} is enabled but has no curated fixtures"
            workspace = tmp_path / "out" / contract.contract_id
            workspace.mkdir(parents=True, exist_ok=True)
            for fixture, evidence in run_contract(contract, fixtures, workspace):
                if fixture.must_pass:
                    assert evidence is not None and evidence.passed is True, (
                        f"{contract.contract_id} failed required fixture {fixture.name}: "
                        f"{fixture.note}"
                    )
                else:
                    assert evidence is None or evidence.passed is not True, (
                        f"{contract.contract_id} accepted {fixture.name} it should refuse: "
                        f"{fixture.note}"
                    )

    def test_blocked_contracts_never_produce_an_encoder_for_execution(self) -> None:
        for contract in CONTRACTS.values():
            if contract.status != "blocked":
                continue
            assert not contract.enabled
            assert contract not in enabled_contracts()

    def test_every_runnable_contract_declares_a_tool_that_could_exist(self) -> None:
        for contract in CONTRACTS.values():
            if contract.status == "blocked":
                # A blocked contract names a tool this project does not bundle;
                # that is the reason it is blocked, not a missing encoder.
                continue
            try:
                encoder_for(contract)
            except EncoderUnavailableError:  # pragma: no cover - guards a typo
                pytest.fail(
                    f"{contract.contract_id} declares tool {contract.tool!r} with no encoder"
                )


class TestCuratedCorpus:
    """The corpus itself is asserted, so a silently-empty gate cannot pass."""

    def test_the_image_corpus_covers_every_declared_edge_case(self, tmp_path: Path) -> None:
        names = {fixture.name for fixture in _image_fixtures(tmp_path)}

        assert names == {
            "ordinary",
            "tiny",
            "alpha",
            "high_bit_depth",
            "metadata",
            "animated",
            "corrupt",
        }

    def test_the_png_contract_behaves_as_the_corpus_expects(self, tmp_path: Path) -> None:
        """Run the declared PNG contract even though it is not yet promoted.

        Promotion is a code change; this test is the evidence that change would
        need, and running it now means the day someone flips the status the
        result is already known.
        """
        contract = CONTRACTS["image-png-lossless-v1"]
        assert discover_tool(contract.tool).available

        fixtures = curated_fixtures(tmp_path / "fixtures", contract)
        outcomes = {
            fixture.name: (None if evidence is None else evidence.passed)
            for fixture, evidence in run_contract(contract, fixtures, tmp_path / "out")
        }

        assert outcomes["ordinary"] is True
        assert outcomes["tiny"] is not True
        assert outcomes["corrupt"] is None
        assert outcomes["animated"] is None  # .gif is outside this contract's formats

    def test_metadata_bearing_input_keeps_its_text_chunks(self, tmp_path: Path) -> None:
        from PIL import Image

        contract = CONTRACTS["image-png-lossless-v1"]
        fixtures = {f.name: f for f in curated_fixtures(tmp_path / "fixtures", contract)}
        destination = tmp_path / "out" / "metadata.png"

        encoder_for(contract).encode(fixtures["metadata"].path, destination)

        with Image.open(destination) as after:
            assert after.info.get("Description") == "curated fixture"
            assert after.info.get("Copyright") == "fileworks"

    def test_high_bit_depth_input_is_not_silently_flattened(self, tmp_path: Path) -> None:
        from PIL import Image

        contract = CONTRACTS["image-png-lossless-v1"]
        fixtures = {f.name: f for f in curated_fixtures(tmp_path / "fixtures", contract)}
        destination = tmp_path / "out" / "deep.png"

        attempt = encoder_for(contract).encode(fixtures["high_bit_depth"].path, destination)

        if attempt.produced_candidate:
            with (
                Image.open(fixtures["high_bit_depth"].path) as before,
                Image.open(destination) as after,
            ):
                assert before.mode == after.mode
            assert attempt.measurements["decoded_pixels_identical"] is True
