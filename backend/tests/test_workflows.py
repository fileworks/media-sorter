"""Static checks for the supported GitHub Actions baseline."""

from pathlib import Path

ROOT = Path(__file__).parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


def _workflow_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(WORKFLOWS.glob("*.yml")))


def test_official_actions_use_node_24_compatible_generations() -> None:
    workflows = _workflow_text()

    assert workflows.count("actions/checkout@v7") == 7
    assert workflows.count("actions/setup-python@v7") == 5
    assert workflows.count("actions/upload-artifact@v7") == 2
    assert workflows.count("actions/setup-node@v7") == 4
    assert workflows.count("actions/download-artifact@v8") == 1

    for stale in (
        "actions/checkout@v4",
        "actions/setup-python@v5",
        "actions/upload-artifact@v4",
        "actions/setup-node@v4",
        "actions/download-artifact@v4",
    ):
        assert stale not in workflows


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
    assert '"resources/**"' not in tauri


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
