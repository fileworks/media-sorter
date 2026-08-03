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
import os
import string
import sys
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


def _platform_roots() -> list[DirectoryEntry]:
    """The places a person actually starts browsing from, per platform."""
    candidates: list[Path] = []
    if sys.platform == "win32":
        candidates = [Path(f"{letter}:\\") for letter in string.ascii_uppercase]
        candidates = [drive for drive in candidates if drive.exists()]
        home = Path.home()
        if home.exists():
            candidates.insert(0, home)
    else:
        candidates = [Path("/"), Path.home()]
        if sys.platform == "darwin":
            volumes = Path("/Volumes")
            if volumes.is_dir():
                with contextlib.suppress(OSError):
                    candidates.extend(
                        sorted(child for child in volumes.iterdir() if child.is_dir())
                    )

    seen: set[str] = set()
    roots: list[DirectoryEntry] = []
    for candidate in candidates:
        resolved = str(candidate)
        if resolved in seen or not candidate.exists():
            continue
        seen.add(resolved)
        roots.append(
            DirectoryEntry(
                name=candidate.name or resolved,
                path=resolved,
                is_dir=True,
                readable=os.access(candidate, os.R_OK),
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
