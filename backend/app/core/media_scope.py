"""Bound media reads to the library the user actually configured.

The media endpoints take a path from the client and return that file's bytes,
thumbnail, or metadata. They used to accept any path on the machine, reasoning
that "the backend is localhost-only and works on the user's own files, so
reading an arbitrary local path here is by design — there is no other origin".

``app.core.api_security`` exists because that reasoning is wrong, and says so:
"Loopback transport alone is not an authorization boundary." It added a
per-launch capability and an exact-origin allowlist precisely because something
else on the machine — or script injected into the packaged webview — can speak
to this API. Anything that reaches an authenticated request could then read any
video, image, or file metadata on the machine, whether or not it had anything
to do with the user's library.

So reads are bounded to the roots the user configured, plus the application's
own data directory, which holds quarantine and conversion originals the review
screens legitimately display. A *protected* root stays readable on purpose:
"comparison-only" means it may be looked at and never mutated, and previewing
is exactly what it is for.

The check resolves symlinks strictly. A link planted inside a library root that
points at ``~/.ssh/id_rsa`` resolves outside every root and is refused, which is
the case a purely textual prefix comparison would let through.
"""

from __future__ import annotations

from pathlib import Path
from typing import TYPE_CHECKING, Any

from app.core.exceptions import MediaSortException
from app.core.paths import resolve_app_paths

if TYPE_CHECKING:  # pragma: no cover - typing only
    from app.core.config import Config


class MediaOutsideLibraryError(MediaSortException):
    """A media read was requested for a path outside every configured root."""

    def __init__(self, message: str, **details: Any) -> None:
        super().__init__(message, "MEDIA_OUTSIDE_LIBRARY", 403, details)


def readable_media_roots(config: Config) -> tuple[Path, ...]:
    """Every location whose media the review screens may legitimately show."""
    candidates: list[str] = []
    profile = config.library_profile
    if profile is not None:
        candidates.extend(root.path for root in profile.roots)
    # Legacy single-root configs, and profiles that have not been migrated.
    candidates.append(config.source_directory)
    candidates.append(config.target_directory)

    roots: list[Path] = []
    seen: set[Path] = set()
    for value in candidates:
        if not value or not str(value).strip():
            continue
        resolved = Path(value).expanduser().resolve(strict=False)
        if resolved not in seen:
            seen.add(resolved)
            roots.append(resolved)

    # Quarantine and conversion originals live under the application's data
    # directory and are shown in review and the quarantine manager.
    app_data = resolve_app_paths().data_dir.resolve(strict=False)
    if app_data not in seen:
        roots.append(app_data)
    return tuple(roots)


def assert_media_readable(raw_path: str, config: Config) -> Path:
    """Return the resolved path, or refuse it as outside the library.

    Raises ``MediaOutsideLibraryError`` rather than the endpoints' usual
    "unsupported media" fallback: a request for someone's private key is not an
    unreadable photo, and reporting it as one would hide it.

    A file that does not exist is resolved without ``strict`` and checked the
    same way. Inside the library it is returned so the endpoint can give its
    ordinary "no preview available" answer — media on a disconnected share
    disappears routinely, and that is not a security event. Outside the library
    it is still refused, so a probe cannot use a non-existent path to learn
    whether something is there.
    """
    candidate = Path(raw_path).expanduser()
    try:
        # `strict` follows the whole chain, so a link planted inside a root that
        # points outside it resolves to its real target and is caught below.
        resolved = candidate.resolve(strict=True)
    except OSError:
        resolved = candidate.resolve(strict=False)

    for root in readable_media_roots(config):
        if resolved == root or root in resolved.parents:
            return resolved
    raise MediaOutsideLibraryError(
        "That file is outside every configured library root", file_path=raw_path
    )
