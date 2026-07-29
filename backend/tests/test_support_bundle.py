"""A diagnostics bundle must be previewable, local, and provably redacted."""

from __future__ import annotations

import hashlib
import json
import zipfile
from pathlib import Path

import pytest

from app.core.action_journal import DurableActionJournal
from app.core.config import Config
from app.core.integrity import (
    FilesystemMetadataSnapshot,
    MutationEffects,
    MutationManifest,
    MutationManifestAction,
    SourceIdentity,
)
from app.services.support_bundle import (
    ALWAYS_EXCLUDED,
    SupportBundleLeakError,
    export_bundle,
    preview_bundle,
)

_SECRET = "sk-live-must-never-be-exported"
_PRIVATE_NAME = "Tax Return 2019 SSN.jpg"


def _state(tmp_path: Path) -> Path:
    """A state root with one journalled operation and one integrity report."""
    root = tmp_path / "state"
    source = tmp_path / "Private Archive" / _PRIVATE_NAME
    source.parent.mkdir(parents=True, exist_ok=True)
    source.write_bytes(b"media")
    digest = hashlib.sha256(b"media").hexdigest()
    observed = source.stat()
    action = MutationManifestAction(
        action_id="act_1",
        kind="copy",
        source=SourceIdentity(
            root_id="input-1",
            relative_path=_PRIVATE_NAME,
            observed_path=str(source),
            sha256=digest,
            metadata=FilesystemMetadataSnapshot(
                size_bytes=observed.st_size,
                mtime_ns=observed.st_mtime_ns,
                atime_ns=observed.st_atime_ns,
            ),
        ),
        destination_path=str(tmp_path / "sorted" / _PRIVATE_NAME),
        expected_sha256=digest,
        expected_size_bytes=observed.st_size,
        effects=MutationEffects(source="retained"),
        preservation_profile_id="organize-only",
        preservation_profile_version=1,
        authorization_origin="default",
    )
    with DurableActionJournal.open(
        root,
        MutationManifest(
            manifest_id="op_bundle",
            operation_id="op_bundle",
            plan_id="plan_bundle",
            profile_id="organize-only",
            effective_config_sha256=digest,
            actions=(action,),
        ),
    ) as journal:
        journal.record(
            "act_1",
            "committed",
            source_safety="redundant_verified_copies",
            staged_path=str(tmp_path / "sorted" / ".stage.tmp"),
        )
    reports = root / "reports"
    reports.mkdir(parents=True, exist_ok=True)
    (reports / "op_bundle.integrity.json").write_text(
        json.dumps(
            {
                "operation_id": "op_bundle",
                "source_path": str(tmp_path / "Private Archive" / _PRIVATE_NAME),
                "bytes_written": 5,
            }
        ),
        encoding="utf-8",
    )
    return root


def _config(tmp_path: Path) -> Config:
    return Config(
        source_directory=str(tmp_path / "Private Archive"),
        target_directory=str(tmp_path / "sorted"),
        ai_tagging_api_key=_SECRET,
        convert_images=False,
    )


def _contents(archive_path: Path) -> str:
    with zipfile.ZipFile(archive_path) as archive:
        return "".join(archive.read(name).decode("utf-8") for name in archive.namelist())


# ------------------------------------------------------------------ #
# Preview                                                             #
# ------------------------------------------------------------------ #


def test_the_preview_lists_what_is_included_and_what_never_is(tmp_path: Path) -> None:
    preview = preview_bundle(_state(tmp_path))

    payload = preview.to_dict()
    names = {item["name"] for item in payload["categories"] if item["included"]}
    assert {"manifest", "configuration_shape", "operation_timeline", "integrity_reports"} <= names
    assert payload["excluded"] == list(ALWAYS_EXCLUDED)
    assert payload["include_paths"] is False


def test_the_preview_says_paths_are_tokenized_unless_requested(tmp_path: Path) -> None:
    root = _state(tmp_path)
    default = preview_bundle(root)
    explicit = preview_bundle(root, include_paths=True)

    default_paths = next(i for i in default.categories if i.name == "paths")
    explicit_paths = next(i for i in explicit.categories if i.name == "paths")
    assert default_paths.included is False
    assert default_paths.detail == "tokenized by default"
    assert explicit_paths.included is True


def test_the_preview_creates_nothing(tmp_path: Path) -> None:
    root = _state(tmp_path)
    before = sorted(path.name for path in root.rglob("*"))

    preview_bundle(root, operation_id="op_bundle")

    assert sorted(path.name for path in root.rglob("*")) == before


# ------------------------------------------------------------------ #
# Export content                                                      #
# ------------------------------------------------------------------ #


def test_an_exported_bundle_carries_the_evidence_support_needs(tmp_path: Path) -> None:
    archive_path = export_bundle(
        _state(tmp_path),
        tmp_path / "out" / "bundle.zip",
        config=_config(tmp_path).to_dict(),
    )

    with zipfile.ZipFile(archive_path) as archive:
        names = set(archive.namelist())
        manifest = json.loads(archive.read("manifest.json"))
    assert {"README.md", "manifest.json", "configuration-shape.json"} <= names
    assert "logging-health.json" in names
    assert "optimization-contracts.json" in names
    assert any(name.startswith("journals/") for name in names)
    assert any(name.startswith("reports/") for name in names)
    assert manifest["application"] == "MediaSorter"
    assert manifest["schema_versions"]["manifest"] >= 1


def test_a_credential_never_reaches_the_archive(tmp_path: Path) -> None:
    archive_path = export_bundle(
        _state(tmp_path),
        tmp_path / "out" / "bundle.zip",
        config=_config(tmp_path).to_dict(),
    )

    contents = _contents(archive_path)
    assert _SECRET not in contents


def test_a_configured_credential_is_reported_as_set_without_its_value(tmp_path: Path) -> None:
    archive_path = export_bundle(
        _state(tmp_path),
        tmp_path / "out" / "bundle.zip",
        config=_config(tmp_path).to_dict(),
    )

    with zipfile.ZipFile(archive_path) as archive:
        shape = json.loads(archive.read("configuration-shape.json"))
    assert shape["ai_tagging_api_key"] == {"type": "str", "configured": True}
    assert "value" not in shape["ai_tagging_api_key"]


def test_paths_and_filenames_are_tokenized_by_default(tmp_path: Path) -> None:
    archive_path = export_bundle(
        _state(tmp_path),
        tmp_path / "out" / "bundle.zip",
        config=_config(tmp_path).to_dict(),
    )

    contents = _contents(archive_path)
    assert _PRIVATE_NAME not in contents
    assert "Private Archive" not in contents
    assert "<root" in contents


def test_real_paths_appear_only_when_explicitly_requested(tmp_path: Path) -> None:
    archive_path = export_bundle(
        _state(tmp_path),
        tmp_path / "out" / "bundle.zip",
        config=_config(tmp_path).to_dict(),
        include_paths=True,
    )

    with zipfile.ZipFile(archive_path) as archive:
        shape = json.loads(archive.read("configuration-shape.json"))
        readme = archive.read("README.md").decode("utf-8")
    assert shape["source_directory"]["value"] == str(tmp_path / "Private Archive")
    assert "at your explicit request" in readme


def test_media_bytes_are_never_included(tmp_path: Path) -> None:
    root = _state(tmp_path)
    (tmp_path / "Private Archive" / _PRIVATE_NAME).write_bytes(b"\xff\xd8\xffUNIQUEMEDIABYTES")

    archive_path = export_bundle(root, tmp_path / "out" / "bundle.zip")

    assert "UNIQUEMEDIABYTES" not in _contents(archive_path)


def test_a_log_excerpt_is_bounded(tmp_path: Path) -> None:
    archive_path = export_bundle(
        _state(tmp_path),
        tmp_path / "out" / "bundle.zip",
        log_excerpt="x" * (2 * 1024 * 1024),
    )

    with zipfile.ZipFile(archive_path) as archive:
        assert len(archive.read("logs/excerpt.log")) == 512 * 1024


def test_the_readme_explains_the_redactions(tmp_path: Path) -> None:
    archive_path = export_bundle(_state(tmp_path), tmp_path / "out" / "bundle.zip")

    with zipfile.ZipFile(archive_path) as archive:
        readme = archive.read("README.md").decode("utf-8")
    assert "not uploaded" in readme
    assert "Media file contents" in readme
    assert "<root1>" in readme


# ------------------------------------------------------------------ #
# The final scan                                                      #
# ------------------------------------------------------------------ #


def test_a_leaking_bundle_is_withheld_rather_than_handed_over(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    from app.services import support_bundle

    monkeypatch.setattr(
        support_bundle,
        "_readme",
        lambda _preview: f"leaked api_key: {_SECRET}",
    )
    destination = tmp_path / "out" / "bundle.zip"

    with pytest.raises(SupportBundleLeakError, match="withheld"):
        export_bundle(_state(tmp_path), destination)

    assert destination.exists() is False, "a leaking archive must not be left on disk"


def test_the_endpoint_requires_a_second_acknowledgement_for_real_paths(
    client: object,
) -> None:
    response = client.post(  # type: ignore[attr-defined]
        "/api/diagnostics/bundle",
        json={"include_paths": True, "acknowledge_paths": False},
    )

    assert response.status_code == 200
    assert response.json()["include_paths"] is False


def test_the_preview_endpoint_reports_categories(client: object) -> None:
    response = client.get("/api/diagnostics/bundle/preview")  # type: ignore[attr-defined]

    assert response.status_code == 200
    payload = response.json()
    assert payload["include_paths"] is False
    assert "Media file contents" in payload["excluded"]
