"""Exercise the offline packaging probe and its failure behavior."""

import runpy
import sys
from pathlib import Path

import pytest

HOOK = Path(__file__).resolve().parents[2] / "scripts" / "verify_frozen_runtime.py"


def test_runtime_hook_does_nothing_on_normal_startup(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    monkeypatch.setattr(sys, "argv", ["mediasort-backend"])
    runpy.run_path(str(HOOK))
    assert capsys.readouterr().out == ""


def test_offline_runtime_probe(
    monkeypatch: pytest.MonkeyPatch, capsys: pytest.CaptureFixture[str]
) -> None:
    pytest.importorskip("onnxruntime")
    pytest.importorskip("tokenizers")
    monkeypatch.setenv("HF_HUB_OFFLINE", "1")
    monkeypatch.setattr(sys, "argv", ["mediasort-backend", "--verify-frozen-runtime"])
    with pytest.raises(SystemExit) as result:
        runpy.run_path(str(HOOK))
    assert result.value.code == 0
    assert '"frozen_runtime": "ok"' in capsys.readouterr().out


def test_probe_rejects_missing_inference_provider(monkeypatch: pytest.MonkeyPatch) -> None:
    ort = pytest.importorskip("onnxruntime")
    pytest.importorskip("tokenizers")
    monkeypatch.setattr(sys, "argv", ["mediasort-backend"])
    namespace = runpy.run_path(str(HOOK))
    monkeypatch.setattr(ort, "get_available_providers", lambda: [])
    with pytest.raises(RuntimeError, match="CPU execution provider"):
        namespace["verify_runtime"]()
