"""AI-NEW-1: the shared encoder is built once, even when first asked for concurrently."""

from __future__ import annotations

import threading
import time
from pathlib import Path
from typing import Any

import pytest

from app.core.bootstrap import ServiceContainer
from app.core.config import Config
from app.services.ai import encoder_factory


def test_concurrent_first_access_builds_one_encoder(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    monkeypatch.setenv("MEDIASORT_DB_PATH", str(tmp_path / "test.db"))
    monkeypatch.setenv("MEDIASORT_MODEL_DIR", str(tmp_path / "models"))
    built: list[object] = []

    def build_encoder(*_args: Any) -> object:
        time.sleep(0.05)
        encoder = object()
        built.append(encoder)
        return encoder

    monkeypatch.setattr(encoder_factory, "build_encoder", build_encoder)
    container = ServiceContainer(Config())
    container._hardware_profile = object()  # type: ignore[assignment]
    barrier = threading.Barrier(4)
    seen: list[object] = []

    def use() -> None:
        barrier.wait()
        seen.append(container.encoder)

    threads = [threading.Thread(target=use) for _ in range(4)]
    for thread in threads:
        thread.start()
    for thread in threads:
        thread.join()

    assert len(built) == 1
    assert seen == built * 4

    container.reset_encoder()
    assert container.encoder is not built[0]
    assert len(built) == 2
