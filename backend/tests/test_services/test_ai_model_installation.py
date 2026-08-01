from __future__ import annotations

import hashlib
import io
import json
from contextlib import AbstractContextManager
from pathlib import Path
from typing import BinaryIO
from urllib.request import Request

import pytest

from app.background_tasks.task_manager import Task
from app.services.ai.model_installation import AiModelStore
from app.services.ai.model_manifest import (
    ModelComponent,
    ModelFile,
    ModelManifestError,
    ModelPack,
    parse_manifest,
)


class _Response(AbstractContextManager[BinaryIO]):
    def __init__(self, content: bytes, *, status: int = 200) -> None:
        self._stream = io.BytesIO(content)
        self.status = status

    def read(self, size: int = -1) -> bytes:
        return self._stream.read(size)

    def __enter__(self) -> _Response:
        return self

    def __exit__(self, *args: object) -> None:
        return None


def _pack(content: bytes = b"verified model") -> ModelPack:
    item = ModelFile("nested/model.bin", len(content), hashlib.sha256(content).hexdigest())
    return ModelPack(
        pack_id="test-pack",
        model_id="test-model",
        display_name="Test model",
        license="MIT",
        license_url="https://example.invalid/license",
        total_size=len(content),
        components=(
            ModelComponent(
                "model",
                "owner/repository",
                "a" * 40,
                (item,),
            ),
        ),
        digest="b" * 64,
    )


def _store(
    tmp_path: Path,
    opener,
    *,
    environment: dict[str, str] | None = None,
    content: bytes = b"verified model",
) -> tuple[AiModelStore, ModelPack]:
    store = AiModelStore(tmp_path, open_url=opener, environment=environment or {})
    pack = _pack(content)
    store.packs = {pack.pack_id: pack}
    return store, pack


def test_install_verifies_and_atomically_publishes_pack(tmp_path: Path) -> None:
    content = b"verified model"
    requested: list[str] = []

    def open_url(request: Request, timeout: float) -> _Response:
        requested.append(request.full_url)
        assert timeout == 30.0
        return _Response(content)

    store, pack = _store(tmp_path, open_url, content=content)
    task = Task("task", operation_kind="model_download")

    result = store._install(task, pack.pack_id)

    assert result["state"] == "ready"
    assert store.component_paths(pack.pack_id) is not None
    installed = store.component_paths(pack.pack_id)["model"] / "nested" / "model.bin"  # type: ignore[index]
    assert installed.read_bytes() == content
    assert pack.components[0].revision in requested[0]
    assert not list(tmp_path.glob(".install-*.staging"))

    record = json.loads((installed.parents[2] / "installation.json").read_text())
    assert record["manifest_sha256"] == pack.digest


def test_integrity_failure_never_publishes_partial_pack(tmp_path: Path) -> None:
    store, pack = _store(tmp_path, lambda request, timeout: _Response(b"wrong payload"))
    task = Task("task", operation_kind="model_download")

    with pytest.raises(OSError, match="integrity check failed"):
        store._install(task, pack.pack_id)

    assert store.component_paths(pack.pack_id) is None
    assert not (tmp_path / pack.pack_id).exists()
    assert not list(tmp_path.glob(".install-*.staging"))


def test_interrupted_download_resumes_with_http_range(tmp_path: Path) -> None:
    content = b"verified model"
    requests: list[Request] = []

    class Interrupted(_Response):
        def __init__(self) -> None:
            super().__init__(content[:4])
            self._reads = 0

        def read(self, size: int = -1) -> bytes:
            self._reads += 1
            if self._reads == 1:
                return super().read(size)
            raise OSError("connection reset")

    def open_url(request: Request, timeout: float) -> _Response:
        requests.append(request)
        range_header = request.get_header("Range")
        if len(requests) == 1:
            return Interrupted()
        assert range_header == "bytes=4-"
        return _Response(content[4:], status=206)

    store, pack = _store(tmp_path, open_url, content=content)
    store._install(Task("task", operation_kind="model_download"), pack.pack_id)

    assert len(requests) == 2
    assert store.status(pack.pack_id).state == "ready"


def test_cancelled_install_cleans_staging_and_publishes_nothing(tmp_path: Path) -> None:
    store, pack = _store(tmp_path, lambda request, timeout: _Response(b"verified model"))
    task = Task("task", operation_kind="model_download")
    task.cancel()

    with pytest.raises(RuntimeError, match="cancelled"):
        store._install(task, pack.pack_id)

    assert store.component_paths(pack.pack_id) is None
    assert not list(tmp_path.glob(".install-*.staging"))


def test_verified_pack_survives_offline_relaunch_and_can_be_removed(tmp_path: Path) -> None:
    content = b"verified model"
    store, pack = _store(tmp_path, lambda request, timeout: _Response(content), content=content)
    store._install(Task("install", operation_kind="model_download"), pack.pack_id)

    def offline(_request: Request, _timeout: float) -> _Response:
        raise OSError("offline relaunch must not contact the network")

    relaunched = AiModelStore(tmp_path, open_url=offline, environment={})
    relaunched.packs = {pack.pack_id: pack}

    assert relaunched.status(pack.pack_id).state == "ready"
    assert relaunched.component_paths(pack.pack_id) is not None
    assert relaunched.remove(pack.pack_id)
    assert relaunched.status(pack.pack_id).state == "not_installed"
    assert relaunched.component_paths(pack.pack_id) is None
    assert not relaunched.remove(pack.pack_id)


def test_mirror_url_is_explicit_and_preserves_pack_layout(tmp_path: Path) -> None:
    requested: list[str] = []

    def open_url(request: Request, timeout: float) -> _Response:
        requested.append(request.full_url)
        return _Response(b"verified model")

    store, pack = _store(
        tmp_path,
        open_url,
        environment={"MEDIASORT_MODEL_MIRROR_URL": "https://models.example.test/releases/v1"},
    )
    store._install(Task("task", operation_kind="model_download"), pack.pack_id)

    assert requested == ["https://models.example.test/releases/v1/test-pack/model/nested/model.bin"]


@pytest.mark.parametrize(
    "mirror",
    [
        "http://models.example.test",
        "ftp://models.example.test",
        "https://user:secret@models.example.test",
        "https://models.example.test?token=secret",
    ],
)
def test_unsafe_mirror_urls_are_rejected(tmp_path: Path, mirror: str) -> None:
    with pytest.raises(ModelManifestError):
        AiModelStore(tmp_path, environment={"MEDIASORT_MODEL_MIRROR_URL": mirror})


def test_manifest_rejects_path_traversal() -> None:
    document = {
        "schema_version": 1,
        "default_source": "https://huggingface.co",
        "packs": {
            "unsafe": {
                "model_id": "unsafe",
                "display_name": "Unsafe",
                "license": "MIT",
                "license_url": "https://example.invalid",
                "total_size": 1,
                "components": {
                    "model": {
                        "repository": "owner/repo",
                        "revision": "a" * 40,
                        "files": [{"path": "../escape", "size": 1, "sha256": "b" * 64}],
                    }
                },
            }
        },
    }

    with pytest.raises(ModelManifestError, match="unsafe model file path"):
        parse_manifest(json.dumps(document))


def test_bundled_manifest_uses_immutable_revisions_and_exact_sizes(tmp_path: Path) -> None:
    store = AiModelStore(tmp_path, environment={})

    assert set(store.packs) == {"clip-lite-v1", "siglip-standard-v1"}
    assert store.packs["clip-lite-v1"].total_size == 608_015_951
    assert store.packs["siglip-standard-v1"].total_size == 412_538_967
    assert all(
        len(component.revision) == 40
        for pack in store.packs.values()
        for component in pack.components
    )
