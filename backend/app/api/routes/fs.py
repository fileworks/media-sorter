"""Directory listing for the folder browser and the root validity probe.

One endpoint answers both questions — "what is inside this folder?" and "does
this folder exist, can I read it, can I write it?" — so the folder a user picks
in the browser is validated by the code that just listed it, and the two can
never disagree.

**Directories only.** File entries are never returned, so this cannot be used to
enumerate somebody's media. It adds no privilege either: everything here goes
through the ordinary filesystem calls the process could already make.
"""

from __future__ import annotations

import asyncio
import contextlib
import ctypes
import os
import string
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path

from fastapi import APIRouter, HTTPException, Query
from pydantic import BaseModel

router = APIRouter()


class DirectoryEntry(BaseModel):
    name: str
    path: str
    is_dir: bool
    readable: bool


class DirectoryListing(BaseModel):
    path: str
    #: ``None`` at a root, so the browser knows it cannot ascend further.
    parent: str | None
    exists: bool
    readable: bool
    writable: bool
    entries: list[DirectoryEntry]


def _is_writable(path: Path) -> bool:
    """Probe writability the way the sorter probes a destination.

    ``validate_target_directory`` gates on ``os.access(root, os.W_OK)``; using
    the same call means a folder this endpoint calls writable is one the sort
    will accept.
    """
    return os.access(path, os.W_OK)


#: The whole root listing waits at most this long for slow drives. A mapped
#: network drive that is offline can block a filesystem call for many seconds.
ROOT_PROBE_BUDGET_SECONDS = 1.5

_Probe = tuple[bool, bool]


def _probe_root(path: Path) -> _Probe:
    """(exists, readable) for one candidate root."""
    exists = path.exists()
    return exists, exists and os.access(path, os.R_OK)


def _probe_concurrently(
    paths: list[Path],
    probe: Callable[[Path], _Probe] = _probe_root,
    *,
    budget_seconds: float = ROOT_PROBE_BUDGET_SECONDS,
) -> dict[Path, _Probe | None]:
    """Probe every root at once and stop waiting after one shared budget.

    A probe that has not answered in time maps to ``None``. Its daemon thread is
    left to finish on its own: Python cannot cancel a blocked filesystem call,
    but it no longer holds up the listing.
    """
    results: dict[Path, _Probe | None] = dict.fromkeys(paths)

    def run(path: Path) -> None:
        with contextlib.suppress(OSError):
            results[path] = probe(path)

    threads = [threading.Thread(target=run, args=(path,), daemon=True) for path in paths]
    for thread in threads:
        thread.start()
    deadline = time.monotonic() + budget_seconds
    for thread in threads:
        thread.join(max(0.0, deadline - time.monotonic()))
    return results


def _windows_drive_letters() -> list[Path]:
    """Drives Windows reports as present, from one call that touches no disk."""
    if sys.platform != "win32":
        return []
    mask = int(ctypes.windll.kernel32.GetLogicalDrives())
    return [
        Path(f"{letter}:\\")
        for index, letter in enumerate(string.ascii_uppercase)
        if mask & (1 << index)
    ]


def _platform_roots() -> list[DirectoryEntry]:
    """The places a person actually starts browsing from, per platform."""
    candidates: list[Path] = [Path.home()]
    if sys.platform == "win32":
        candidates.extend(_windows_drive_letters())
    else:
        candidates.insert(0, Path("/"))
        if sys.platform == "darwin":
            volumes = Path("/Volumes")
            if volumes.is_dir():
                with contextlib.suppress(OSError):
                    candidates.extend(
                        sorted(child for child in volumes.iterdir() if child.is_dir())
                    )

    unique = list(dict.fromkeys(candidates))
    probes = _probe_concurrently(unique)
    roots: list[DirectoryEntry] = []
    for candidate in unique:
        probe = probes[candidate]
        if probe is not None and not probe[0]:
            continue
        resolved = str(candidate)
        roots.append(
            DirectoryEntry(
                name=candidate.name or resolved,
                path=resolved,
                is_dir=True,
                # A drive that did not answer in time is listed but not readable,
                # so the browser can say so instead of hiding the drive.
                readable=probe is not None and probe[1],
            )
        )
    return roots


def _listing(raw_path: str) -> DirectoryListing:
    if not raw_path.strip():
        return DirectoryListing(
            path="",
            parent=None,
            exists=True,
            readable=True,
            writable=False,
            entries=_platform_roots(),
        )

    path = Path(raw_path).expanduser()
    if not path.exists():
        raise HTTPException(status_code=404, detail=f"No such folder: {path}")
    if not path.is_dir():
        raise HTTPException(status_code=400, detail=f"That path is a file, not a folder: {path}")

    parent = None if path.parent == path else str(path.parent)
    readable = os.access(path, os.R_OK)

    entries: list[DirectoryEntry] = []
    if readable:
        try:
            for child in sorted(path.iterdir(), key=lambda item: item.name.lower()):
                # Never report a file. A name that vanishes mid-scan, or a broken
                # symlink, simply is not listed.
                try:
                    if not child.is_dir():
                        continue
                except OSError:
                    continue
                entries.append(
                    DirectoryEntry(
                        name=child.name,
                        path=str(child),
                        is_dir=True,
                        readable=os.access(child, os.R_OK),
                    )
                )
        except OSError:
            # Readable by the mode bits but not enumerable in practice; report it
            # the same way as an unreadable folder rather than raising.
            readable = False
            entries = []

    return DirectoryListing(
        path=str(path),
        parent=parent,
        exists=True,
        readable=readable,
        writable=_is_writable(path),
        entries=entries,
    )


@router.get("/fs/list", response_model=DirectoryListing)
async def list_directory(
    path: str = Query(default="", description="Absolute path, or empty for the platform roots"),
) -> DirectoryListing:
    """List the sub-directories of one folder, and report what it permits."""
    return await asyncio.to_thread(_listing, path)
