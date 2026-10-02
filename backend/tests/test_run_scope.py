"""Run-local library scopes are stable, canonical, and never persisted."""

from __future__ import annotations

from pathlib import Path
from unittest.mock import patch

import pytest

from app.core.config import Config
from app.core.exceptions import LibraryProfileError
from app.core.library_profiles import LibraryProfile, LibraryRoot
from app.core.run_scope import apply_run_scope


def _config(first: Path, second: Path, destination: Path) -> Config:
    profile = LibraryProfile(
        profile_id="run-scope-test",
        name="Run scope test",
        transfer_mode="copy",
        roots=[
            LibraryRoot(root_id="phone", role="input", path=str(first)),
            LibraryRoot(root_id="camera", role="input", path=str(second)),
            LibraryRoot(root_id="destination", role="destination", path=str(destination)),
        ],
    )
    return Config(
        source_directory=str(first),
        target_directory=str(destination),
        copy_instead_of_move=True,
        library_profile=profile,
    )


def test_root_id_excludes_an_offline_root_without_probing_its_path(tmp_path: Path) -> None:
    phone = tmp_path / "phone"
    destination = tmp_path / "destination"
    phone.mkdir()
    destination.mkdir()
    offline = tmp_path / "unmounted-camera"
    config = _config(phone, offline, destination)

    with patch("app.core.run_scope._same_root_path", side_effect=AssertionError("path probed")):
        scoped = apply_run_scope(config, ["camera"])

    assert scoped.excluded_root_ids == ("camera",)
    assert scoped.excluded_paths == (str(offline),)
    assert scoped.config.library_profile is not None
    assert [root.root_id for root in scoped.config.library_profile.roots] == [
        "phone",
        "destination",
    ]


def test_scope_is_a_copy_and_never_changes_the_saved_profile(tmp_path: Path) -> None:
    phone = tmp_path / "phone"
    camera = tmp_path / "camera"
    destination = tmp_path / "destination"
    for path in (phone, camera, destination):
        path.mkdir()
    config = _config(phone, camera, destination)

    scoped = apply_run_scope(config, ["camera"])

    assert scoped.config is not config
    assert config.library_profile is not None
    assert [root.root_id for root in config.library_profile.roots] == [
        "phone",
        "camera",
        "destination",
    ]


def test_an_alias_resolves_to_the_configured_root(tmp_path: Path) -> None:
    phone = tmp_path / "phone"
    camera = tmp_path / "camera"
    destination = tmp_path / "destination"
    for path in (phone, camera, destination):
        path.mkdir()
    alias = tmp_path / "camera-alias"
    try:
        alias.symlink_to(camera, target_is_directory=True)
    except OSError as error:  # pragma: no cover - platform privilege policy
        pytest.skip(f"directory aliases are unavailable: {error}")
    config = _config(phone, camera, destination)

    scoped = apply_run_scope(config, [str(alias)])

    assert scoped.excluded_root_ids == ("camera",)


def test_windows_style_case_variant_resolves_to_the_same_root(
    tmp_path: Path, monkeypatch: pytest.MonkeyPatch
) -> None:
    phone = tmp_path / "phone"
    camera = tmp_path / "Camera"
    destination = tmp_path / "destination"
    for path in (phone, camera, destination):
        path.mkdir()
    config = _config(phone, camera, destination)
    monkeypatch.setattr("app.core.run_scope.os.path.normcase", lambda value: value.casefold())

    scoped = apply_run_scope(config, [str(tmp_path / "camera")])

    assert scoped.excluded_root_ids == ("camera",)


@pytest.mark.parametrize(
    ("requested", "reason"),
    [("destination", "destination_run_exclusion"), ("unknown", "unknown_run_exclusion")],
)
def test_destination_and_unknown_exclusions_are_rejected(
    tmp_path: Path, requested: str, reason: str
) -> None:
    phone = tmp_path / "phone"
    camera = tmp_path / "camera"
    destination = tmp_path / "destination"
    for path in (phone, camera, destination):
        path.mkdir()
    config = _config(phone, camera, destination)

    with pytest.raises(LibraryProfileError) as error:
        apply_run_scope(config, [requested])

    assert error.value.details["reason"] == reason


def test_sibling_prefix_is_not_mistaken_for_the_configured_root(tmp_path: Path) -> None:
    phone = tmp_path / "phone"
    camera = tmp_path / "camera"
    destination = tmp_path / "destination"
    for path in (phone, camera, destination):
        path.mkdir()
    config = _config(phone, camera, destination)

    with pytest.raises(LibraryProfileError) as error:
        apply_run_scope(config, [str(tmp_path / "camera-backup")])

    assert error.value.details["reason"] == "unknown_run_exclusion"
