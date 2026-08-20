"""F-10 / DEC-06 — MediaSorter is MIT and ships GPL-3.0 ffmpeg binaries.

That is allowed, and it comes with obligations: the licence text travels with
the binaries, and a written offer for the corresponding source travels with the
licence. Neither existed — `fetch_ffmpeg.py` downloaded GPL binaries and wrote
no licence file at all.

The other half is that the notice has to describe what actually shipped. The
provenance is generated at fetch time while the manifest is tracked, and the
local artifact was two revisions behind the manifest with nothing comparing
them, so a release could ship binaries whose recorded origin — and therefore
whose licence notice — named the wrong versions.
"""

from __future__ import annotations

import hashlib
import importlib.util
import json
import sys
from pathlib import Path

import pytest

REPO_ROOT = Path(__file__).resolve().parents[2]
LICENSES = REPO_ROOT / "frontend" / "src-tauri" / "resources" / "licenses"
GPL = LICENSES / "COPYING.GPLv3"
OFFER = LICENSES / "FFMPEG-LICENSE-AND-SOURCE-OFFER.md"
SOURCES = REPO_ROOT / "scripts" / "ffmpeg-sources.json"
TAURI_CONF = REPO_ROOT / "frontend" / "src-tauri" / "tauri.conf.json"

#: The canonical GPL-3.0 text. Pinned by digest because "a file called
#: COPYING.GPLv3" is not the obligation — shipping the licence is.
GPLV3_SHA256 = "8ceb4b9ee5adedde47b31e975c1d90c73ad27b6b165a1dcd80c7c545eb65b903"

# The provenance checks live here, not in `release_integrity`: adding the
# manifest-version check pushed that file past its review baseline, and the
# growth policy asks for a cohesive home rather than a raised number.
SCRIPT_PATH = REPO_ROOT / "scripts" / "native_provenance.py"
_SPEC = importlib.util.spec_from_file_location("native_provenance_licensing", SCRIPT_PATH)
assert _SPEC is not None and _SPEC.loader is not None
native_provenance = importlib.util.module_from_spec(_SPEC)
sys.modules[_SPEC.name] = native_provenance
_SPEC.loader.exec_module(native_provenance)


def _manifest() -> dict[str, object]:
    manifest: dict[str, object] = json.loads(SOURCES.read_text(encoding="utf-8"))
    return manifest


class TestTheNoticeShips:
    def test_the_gpl_text_is_present_and_is_the_real_one(self) -> None:
        assert GPL.is_file()
        digest = hashlib.sha256(GPL.read_bytes()).hexdigest()

        assert digest == GPLV3_SHA256

    def test_a_written_offer_is_present(self) -> None:
        assert OFFER.is_file()
        text = OFFER.read_text(encoding="utf-8")

        # Section 6's requirement, in the words a recipient can act on.
        assert "written offer" in text.lower()
        assert "corresponding source" in text.lower()
        assert "three years" in text.lower()

    def test_the_offer_names_the_versions_that_ship(self) -> None:
        """A notice describing some other build is not a notice."""
        manifest = _manifest()
        text = OFFER.read_text(encoding="utf-8")

        assert str(manifest["manifest_version"]) in text
        targets = manifest["targets"]
        assert isinstance(targets, dict)
        for entries in targets.values():
            for entry in entries:
                assert str(entry["upstream_version"]) in text
                assert str(entry["url"]) in text

    def test_the_bundler_collects_the_licences(self) -> None:
        """Present in the repository is not present in the installer.

        They live *inside* `resources/` rather than under a second bundle
        pattern on purpose: `test_frozen_backend_bundles_runtime_resources`
        pins that list to exactly one recursive glob, because splitting it
        broke four releases — a second pattern changed the bundled layout and
        packaging verification then failed on a missing artifact.
        """
        conf = json.loads(TAURI_CONF.read_text(encoding="utf-8"))

        assert conf["bundle"]["resources"] == ["resources/**/*"]
        assert LICENSES.parent.name == "resources"


class TestTheNoticeDescribesWhatShipped:
    def _provenance(self, version: str) -> dict[str, object]:
        return {"schema_version": 1, "source_manifest_version": version}

    def test_a_provenance_from_the_tracked_manifest_passes(self) -> None:
        current = str(_manifest()["manifest_version"])

        native_provenance._validate_manifest_version(self._provenance(current))

    def test_a_provenance_from_an_older_manifest_is_refused(self) -> None:
        with pytest.raises(
            native_provenance.ReleaseIntegrityError, match="different source manifest"
        ):
            native_provenance._validate_manifest_version(self._provenance("2026-07-29.1"))

    def test_a_provenance_with_no_manifest_version_is_refused(self) -> None:
        """An older provenance predating the field must not pass by omission."""
        with pytest.raises(native_provenance.ReleaseIntegrityError):
            native_provenance._validate_manifest_version({"schema_version": 1})
