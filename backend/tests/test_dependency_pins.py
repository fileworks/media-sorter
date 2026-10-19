"""Direct dependencies are exact pins so Renovate's lockfile updates stay inside the soak.

`uv lock --upgrade-package <name>` and a range-bumping `cargo update` resolve the
newest release a range allows. Renovate offers only releases older than its
seven-day minimum release age, so a range lets the resolver pick a newer,
still-soaking release, and Renovate fails the branch with an artifact error.
An exact pin makes the resolver install exactly the version Renovate offered.
Deliberate caps (any `<` bound) stay ranges; they need Dashboard approval anyway.
"""

import re
from pathlib import Path

import tomllib

ROOT = Path(__file__).parents[2]
# `name[extras]==1.2.3`: one exact release, no wildcard, no second clause.
_EXACT_PYTHON = re.compile(r"[A-Za-z0-9][A-Za-z0-9._-]*(\[[^\]]+\])?==[0-9][0-9A-Za-z.+!]*")
_CAPPED_PYTHON = re.compile(r"<=?\s*[0-9]")
# `=1.2.3`: Cargo's exact form, fully specified, so it cannot float like `=1`.
_EXACT_CARGO = re.compile(r"=[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.-]+)?")


def _python_requirements() -> list[str]:
    project = tomllib.loads((ROOT / "backend" / "pyproject.toml").read_text(encoding="utf-8"))
    specs = list(project["project"]["dependencies"])
    for group in project["project"].get("optional-dependencies", {}).values():
        specs.extend(group)
    return specs


def _cargo_requirements() -> dict[str, str]:
    manifest = tomllib.loads(
        (ROOT / "frontend" / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    )
    tables = [manifest.get("dependencies", {}), manifest.get("build-dependencies", {})]
    tables.extend(target.get("dependencies", {}) for target in manifest.get("target", {}).values())
    requirements: dict[str, str] = {}
    for table in tables:
        for name, value in table.items():
            version = value if isinstance(value, str) else value.get("version", "")
            requirements[name] = str(version).replace(" ", "")
    return requirements


def test_python_dependencies_are_pinned_or_deliberately_capped() -> None:
    specs = _python_requirements()
    requirements = [spec.split(";", maxsplit=1)[0].replace(" ", "") for spec in specs]
    exact = [item for item in requirements if _EXACT_PYTHON.fullmatch(item)]
    loose = [
        item
        for item in requirements
        if not _EXACT_PYTHON.fullmatch(item) and not _CAPPED_PYTHON.search(item)
    ]
    assert exact, "no exact pins found; the manifest shape changed"
    assert loose == []


def test_cargo_dependencies_are_exact() -> None:
    requirements = _cargo_requirements()
    assert "tauri" in requirements, "no Tauri crate found; the manifest shape changed"
    loose = [
        f"{name} {version}"
        for name, version in requirements.items()
        if not _EXACT_CARGO.fullmatch(version)
    ]
    assert loose == []
