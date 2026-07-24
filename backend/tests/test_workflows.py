"""Static checks for the supported GitHub Actions baseline."""

from pathlib import Path

ROOT = Path(__file__).parents[2]
WORKFLOWS = ROOT / ".github" / "workflows"


def _workflow_text() -> str:
    return "\n".join(path.read_text(encoding="utf-8") for path in sorted(WORKFLOWS.glob("*.yml")))


def test_official_actions_use_node_24_compatible_generations() -> None:
    workflows = _workflow_text()

    assert workflows.count("actions/checkout@v7") == 5
    assert workflows.count("actions/setup-python@v7") == 3
    assert workflows.count("actions/upload-artifact@v7") == 2
    assert workflows.count("actions/setup-node@v7") == 3
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

    assert workflows.count("Set up Node 24") == 3
    assert workflows.count('node-version: "24"') == 3
    assert "Set up Node 20" not in workflows
    assert 'node-version: "20"' not in workflows


def test_manual_release_validation_cannot_publish_without_a_tag() -> None:
    release = (WORKFLOWS / "release.yml").read_text(encoding="utf-8")

    assert "workflow_dispatch:" in release
    assert "if: startsWith(github.ref, 'refs/tags/v')" in release
