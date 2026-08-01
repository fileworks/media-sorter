"""Static checks for the supported GitHub Actions baseline."""

import re
from pathlib import Path

ROOT = Path(__file__).parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


def _workflow_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(WORKFLOWS.glob("*.yml")))


def test_official_actions_use_node_24_compatible_generations() -> None:
    workflows = _workflow_text()

    approved = {
        "actions/checkout": {"v5", "v7"},
        "actions/setup-python": {"v7"},
        "actions/upload-artifact": {"v7"},
        "actions/setup-node": {"v7"},
        "actions/download-artifact": {"v8"},
    }
    for action, versions in approved.items():
        observed = set(re.findall(rf"{re.escape(action)}@([^\s]+)", workflows))
        assert observed
        assert observed <= versions


def test_all_explicit_node_toolchains_use_node_24() -> None:
    workflows = _workflow_text()

    assert workflows.count("Set up Node 24") == 4
    assert workflows.count('node-version: "24"') == 4
    assert "Set up Node 20" not in workflows
    assert 'node-version: "20"' not in workflows


def test_manual_release_validation_cannot_publish_without_a_tag() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")

    assert "workflow_dispatch:" in release
    assert "if: startsWith(github.ref, 'refs/tags/v')" in release


def test_frozen_backend_bundles_runtime_resources() -> None:
    makefile = (ROOT / "Makefile").read_text(encoding="utf-8")
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")
    tauri = (ROOT / "frontend" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")

    assert "--collect-all=app.resources" in makefile
    assert "bundle-clip" not in makefile
    assert "bundle-clip" not in release
    # `resources/**` is correct here, and the previous assertion that it must be
    # absent is what broke four releases.
    #
    # It was split into `resources/backend/**` + `resources/ffmpeg/**` to keep
    # on-demand AI model packs out of the installer. But packs never live here:
    # ModelInstaller roots them at `resolve_app_paths().data_dir / "ai-models"`,
    # a PlatformDirs location written at runtime, so no glob over the source tree
    # can pick them up.
    #
    # The split cost two things. `resources/ffmpeg/**` matched nothing, because
    # fetch_ffmpeg writes three flat files and `**` needs a directory to descend
    # into. And splitting changed the bundled layout, so the backend landed
    # somewhere other than Contents/Resources/resources/backend/ and packaging
    # verification failed on a missing artifact.
    assert '"resources/**"' in tauri


def test_model_packs_are_never_bundled_into_the_installer() -> None:
    """The reason `resources/**` is safe, asserted rather than assumed.

    Packs are rooted at the PlatformDirs data directory and written at runtime,
    so no glob over the source tree can sweep them into the bundle. If that ever
    changes, `resources/**` stops being safe and this fails first.
    """
    installer = (ROOT / "backend" / "app" / "services" / "ai" / "model_installation.py").read_text(
        encoding="utf-8"
    )

    assert 'MODEL_ROOT_NAME = "ai-models"' in installer
    assert "resolve_app_paths().data_dir / MODEL_ROOT_NAME" in installer
    assert "src-tauri" not in installer


def test_every_bundled_resource_glob_matches_something() -> None:
    """A declared glob that matches nothing aborts the Tauri build.

    `resources/ffmpeg/**` matched nothing and stranded four tags with no
    installers: `fetch_ffmpeg` writes three flat files and no directory, so a
    trailing `**` had nothing to descend into. `resources/backend/**` was fine
    only because that tree happens to contain a subdirectory.

    The declaration deliberately does not use `resources/**` — on-demand AI model
    packs land under `resources/` and must not ship inside the installer — so the
    globs have to be right rather than broad.
    """
    import json

    config = json.loads(
        (ROOT / "frontend" / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    )
    tauri_root = ROOT / "frontend" / "src-tauri"

    for pattern in config["tauri"]["bundle"]["resources"]:
        directory, _, tail = pattern.rpartition("/")
        target = tauri_root / directory
        if not target.is_dir():
            continue  # not built in this checkout; the release job builds it
        if tail == "**":
            # `**` descends into directories, so it needs at least one.
            assert any(child.is_dir() for child in target.iterdir()), (
                f"{pattern} uses ** but {directory} holds no directory to descend into"
            )
        assert any(target.iterdir()), f"{pattern} matches nothing"
