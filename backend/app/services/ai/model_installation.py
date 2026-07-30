"""Verified, optional local-AI model installation.

Models are application-managed caches, never implicit library downloads. Every
source revision is immutable, every byte is covered by the bundled manifest,
and a completed pack is published with one same-filesystem rename.
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import threading
import time
import uuid
from collections.abc import Callable, Mapping
from contextlib import AbstractContextManager, closing
from dataclasses import dataclass
from datetime import datetime, timezone
from pathlib import Path, PurePosixPath
from typing import BinaryIO
from urllib.parse import quote, urlparse
from urllib.request import Request, urlopen

from app.background_tasks.task_manager import Task
from app.core.exceptions import MediaSortException
from app.core.logging_config import get_logger
from app.core.paths import resolve_app_paths
from app.services.ai.model_manifest import (
    ModelComponent,
    ModelFile,
    ModelManifestError,
    ModelPack,
    load_manifest,
)

logger = get_logger(__name__)

MODEL_ROOT_NAME = "ai-models"
INSTALLATION_RECORD = "installation.json"
DOWNLOAD_CHUNK_BYTES = 1024 * 1024
DOWNLOAD_ATTEMPTS = 3
DISK_RESERVE_BYTES = 64 * 1024 * 1024


@dataclass(frozen=True)
class ModelStatus:
    pack_id: str
    model_id: str
    display_name: str
    state: str
    total_size: int
    installed_size: int
    license: str
    license_url: str
    source: str
    task_id: str | None = None
    error: str | None = None

    def to_dict(self) -> dict[str, object]:
        return {
            "pack_id": self.pack_id,
            "model_id": self.model_id,
            "display_name": self.display_name,
            "state": self.state,
            "total_size": self.total_size,
            "installed_size": self.installed_size,
            "license": self.license,
            "license_url": self.license_url,
            "source": self.source,
            "task_id": self.task_id,
            "error": self.error,
        }


OpenUrl = Callable[[Request, float], AbstractContextManager[BinaryIO]]


def _default_open(request: Request, timeout: float) -> AbstractContextManager[BinaryIO]:
    return closing(urlopen(request, timeout=timeout))  # noqa: S310 - origins are validated


class AiModelStore:
    """Own optional model downloads and expose only verified component paths."""

    def __init__(
        self,
        root: Path | None = None,
        *,
        environment: Mapping[str, str] | None = None,
        open_url: OpenUrl = _default_open,
    ) -> None:
        values = os.environ if environment is None else environment
        override = values.get("MEDIASORT_MODEL_DIR")
        self.root = (
            Path(override) if override else root or resolve_app_paths().data_dir / MODEL_ROOT_NAME
        )
        self.root.mkdir(parents=True, exist_ok=True)
        self._source, self.packs = load_manifest()
        self._mirror = values.get("MEDIASORT_MODEL_MIRROR_URL", "").rstrip("/")
        self._validate_mirror()
        self._open_url = open_url
        self._lock = threading.RLock()
        self._last_error: dict[str, str] = {}
        self._progress_log_bucket: dict[str, int] = {}
        self._cleanup_staging()

    @property
    def source_label(self) -> str:
        return self._mirror or self._source

    def _validate_mirror(self) -> None:
        if not self._mirror:
            return
        parsed = urlparse(self._mirror)
        local = parsed.hostname in {"127.0.0.1", "localhost", "::1"}
        if parsed.scheme != "https" and not (parsed.scheme == "http" and local):
            raise ModelManifestError("model mirror must use HTTPS (HTTP is local-test only)")
        if parsed.username or parsed.password or parsed.query or parsed.fragment:
            raise ModelManifestError("model mirror URL must not contain credentials or a query")

    def _cleanup_staging(self) -> None:
        for candidate in self.root.glob(".install-*.staging"):
            shutil.rmtree(candidate, ignore_errors=True)

    def _pack_directory(self, pack: ModelPack) -> Path:
        return self.root / pack.pack_id / pack.digest[:16]

    def _record_path(self, pack: ModelPack) -> Path:
        return self._pack_directory(pack) / INSTALLATION_RECORD

    def _installed(self, pack: ModelPack, *, full: bool) -> bool:
        directory = self._pack_directory(pack)
        try:
            record = json.loads(self._record_path(pack).read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return False
        if record.get("pack_id") != pack.pack_id or record.get("manifest_sha256") != pack.digest:
            return False
        for component in pack.components:
            for item in component.files:
                path = directory / component.name / item.path
                try:
                    if not path.is_file() or path.stat().st_size != item.size:
                        return False
                    if full and _sha256(path) != item.sha256:
                        return False
                except OSError:
                    return False
        return True

    def status(self, pack_id: str, *, task: Task | None = None) -> ModelStatus:
        pack = self._pack(pack_id)
        state = "ready" if self._installed(pack, full=False) else "not_installed"
        if task is not None and task.status in ("pending", "running"):
            state = "downloading"
        elif task is not None and task.status == "failed":
            state = "error"
        installed_size = pack.total_size if state == "ready" else 0
        error = (
            task.failure.message
            if task is not None and task.failure is not None
            else self._last_error.get(pack_id)
        )
        return ModelStatus(
            pack_id=pack.pack_id,
            model_id=pack.model_id,
            display_name=pack.display_name,
            state=state,
            total_size=pack.total_size,
            installed_size=installed_size,
            license=pack.license,
            license_url=pack.license_url,
            source=self.source_label,
            task_id=task.id if task is not None else None,
            error=error,
        )

    def component_paths(self, pack_id: str, *, verify: bool = True) -> dict[str, Path] | None:
        pack = self._pack(pack_id)
        if not self._installed(pack, full=verify):
            return None
        directory = self._pack_directory(pack)
        return {component.name: directory / component.name for component in pack.components}

    async def install(self, task: Task, pack_id: str) -> dict[str, object]:
        import asyncio

        return await asyncio.to_thread(self._install, task, pack_id)

    def _install(self, task: Task, pack_id: str) -> dict[str, object]:
        pack = self._pack(pack_id)
        with self._lock:
            if self._installed(pack, full=True):
                task.update_progress(
                    pack.total_size,
                    total=pack.total_size,
                    bytes_done=pack.total_size,
                    bytes_total=pack.total_size,
                    unit="bytes",
                )
                return self.status(pack_id).to_dict()
            free = shutil.disk_usage(self.root).free
            required = pack.total_size + DISK_RESERVE_BYTES
            if free < required:
                raise MediaSortException(
                    status_code=507,
                    message="Not enough free space to install the local AI model.",
                    code="MODEL_DISK_SPACE",
                    details={"required_bytes": required, "free_bytes": free},
                )
            staging = self.root / f".install-{pack.pack_id}-{uuid.uuid4().hex}.staging"
            staging.mkdir(parents=True)
            done = 0
            self._progress_log_bucket[task.id] = 0
            task.transition("downloading_model", total=pack.total_size)
            try:
                for component in pack.components:
                    for item in component.files:
                        if task.cancel_token.is_set():
                            task.observe_cancellation()
                            raise RuntimeError("model installation cancelled")
                        target = staging / component.name / item.path
                        target.parent.mkdir(parents=True, exist_ok=True)
                        self._download(task, pack, component, item, target, done)
                        done += item.size
                        task.update_progress(
                            done,
                            total=pack.total_size,
                            bytes_done=done,
                            bytes_total=pack.total_size,
                            unit="bytes",
                        )
                task.transition("verifying_model", total=pack.total_size)
                task.update_progress(
                    pack.total_size,
                    total=pack.total_size,
                    bytes_done=pack.total_size,
                    bytes_total=pack.total_size,
                    unit="bytes",
                )
                self._verify_staging(pack, staging)
                _write_record(staging, pack, self.source_label)
                task.checkpoint("model-pack-verified")
                task.transition("publishing_model", total=pack.total_size)
                task.update_progress(
                    pack.total_size,
                    total=pack.total_size,
                    bytes_done=pack.total_size,
                    bytes_total=pack.total_size,
                    unit="bytes",
                )
                destination = self._pack_directory(pack)
                destination.parent.mkdir(parents=True, exist_ok=True)
                if destination.exists():
                    shutil.rmtree(destination)
                os.replace(staging, destination)
                self._remove_old_versions(pack, destination)
                self._last_error.pop(pack_id, None)
                task.checkpoint("model-pack-published")
                task.update_progress(
                    pack.total_size,
                    total=pack.total_size,
                    bytes_done=pack.total_size,
                    bytes_total=pack.total_size,
                    unit="bytes",
                )
                logger.info(
                    "AI model pack installed",
                    pack_id=pack.pack_id,
                    bytes=pack.total_size,
                    source=self.source_label,
                )
                return self.status(pack_id).to_dict()
            except Exception as exc:
                self._last_error[pack_id] = str(exc)
                raise
            finally:
                self._progress_log_bucket.pop(task.id, None)
                shutil.rmtree(staging, ignore_errors=True)

    def remove(self, pack_id: str) -> bool:
        pack = self._pack(pack_id)
        with self._lock:
            directory = self.root / pack.pack_id
            removed = directory.exists()
            if removed:
                shutil.rmtree(directory, ignore_errors=False)
            self._last_error.pop(pack_id, None)
            return removed

    def _download(
        self,
        task: Task,
        pack: ModelPack,
        component: ModelComponent,
        item: ModelFile,
        target: Path,
        completed_before: int,
    ) -> None:
        partial = target.with_name(f".{target.name}.partial")
        for attempt in range(1, DOWNLOAD_ATTEMPTS + 1):
            offset = partial.stat().st_size if partial.exists() else 0
            if offset > item.size:
                partial.unlink()
                offset = 0
            request = Request(
                self._url(pack, component, item),
                headers={
                    "User-Agent": "MediaSorter-model-installer/1",
                    **({"Range": f"bytes={offset}-"} if offset else {}),
                },
            )
            try:
                with self._open_url(request, 30.0) as response:
                    status = int(getattr(response, "status", 200))
                    append = offset > 0 and status == 206
                    if offset and not append:
                        offset = 0
                    mode = "ab" if append else "wb"
                    with partial.open(mode) as handle:
                        for chunk in iter(lambda: response.read(DOWNLOAD_CHUNK_BYTES), b""):
                            if task.cancel_token.is_set():
                                task.observe_cancellation()
                                raise RuntimeError("model installation cancelled")
                            handle.write(chunk)
                            offset += len(chunk)
                            self._report_download_progress(
                                task,
                                pack,
                                completed_before + offset,
                            )
                        handle.flush()
                        os.fsync(handle.fileno())
                if partial.stat().st_size != item.size or _sha256(partial) != item.sha256:
                    partial.unlink(missing_ok=True)
                    raise OSError(f"integrity check failed for {component.name}/{item.path}")
                os.replace(partial, target)
                return
            except Exception:
                if task.cancel_token.is_set() or attempt == DOWNLOAD_ATTEMPTS:
                    raise
                time.sleep(min(2 ** (attempt - 1), 4))

    def _report_download_progress(self, task: Task, pack: ModelPack, current: int) -> None:
        task.update_progress(
            current,
            total=pack.total_size,
            bytes_done=current,
            bytes_total=pack.total_size,
            unit="bytes",
        )
        bucket = min(10, (current * 10) // pack.total_size)
        previous = self._progress_log_bucket.get(task.id, 0)
        if bucket <= previous:
            return
        self._progress_log_bucket[task.id] = bucket
        logger.info(
            "AI model download progress",
            task_id=task.id,
            pack_id=pack.pack_id,
            bytes_done=current,
            bytes_total=pack.total_size,
            percentage=bucket * 10,
        )

    def _url(self, pack: ModelPack, component: ModelComponent, item: ModelFile) -> str:
        encoded_path = "/".join(quote(part, safe="") for part in PurePosixPath(item.path).parts)
        if self._mirror:
            return f"{self._mirror}/{pack.pack_id}/{component.name}/{encoded_path}"
        repository = "/".join(quote(part, safe="") for part in component.repository.split("/"))
        return (
            f"{self._source}/{repository}/resolve/{component.revision}/{encoded_path}?download=true"
        )

    def _verify_staging(self, pack: ModelPack, staging: Path) -> None:
        for component in pack.components:
            for item in component.files:
                path = staging / component.name / item.path
                if path.stat().st_size != item.size or _sha256(path) != item.sha256:
                    raise OSError(f"integrity check failed for {component.name}/{item.path}")

    def _remove_old_versions(self, pack: ModelPack, current: Path) -> None:
        for candidate in current.parent.iterdir():
            if candidate != current and candidate.is_dir():
                shutil.rmtree(candidate, ignore_errors=True)

    def _pack(self, pack_id: str) -> ModelPack:
        try:
            return self.packs[pack_id]
        except KeyError as exc:
            raise MediaSortException(
                status_code=404,
                message="Unknown local AI model pack.",
                code="MODEL_PACK_UNKNOWN",
                details={"pack_id": pack_id},
            ) from exc


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(DOWNLOAD_CHUNK_BYTES), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _write_record(staging: Path, pack: ModelPack, source: str) -> None:
    document = {
        "schema_version": 1,
        "pack_id": pack.pack_id,
        "model_id": pack.model_id,
        "manifest_sha256": pack.digest,
        "installed_at": datetime.now(timezone.utc).isoformat(),
        "source": source,
    }
    path = staging / INSTALLATION_RECORD
    with path.open("w", encoding="utf-8") as handle:
        json.dump(document, handle, indent=2, sort_keys=True)
        handle.write("\n")
        handle.flush()
        os.fsync(handle.fileno())
