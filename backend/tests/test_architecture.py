"""The dependency rule, enforced rather than remembered (A-01).

`app.core` holds the rules; `app.services` performs the work. `core/sort_plan.py`
imported `app.services.destination` and `app.services.outcome_provenance` at
module level, inverting that — which meant the plan model could not be imported
without dragging in the conversion service, the extraction service and the AI
classifier behind them.

An architecture rule stated only in prose is not enforced, so this is the
executable form of it.
"""

from __future__ import annotations

import ast
from pathlib import Path

import pytest

APP = Path(__file__).resolve().parents[1] / "app"
CORE = APP / "core"


def _core_modules() -> list[Path]:
    return sorted(path for path in CORE.rglob("*.py") if "__pycache__" not in path.parts)


def _toplevel_imports(path: Path) -> list[str]:
    """Every module imported at import time — deferred imports excluded.

    A deferred import inside a function or `TYPE_CHECKING` block does not create
    an import-time dependency, and `core/bootstrap.py` legitimately uses them:
    it is the composition root, so naming every service is its whole job.
    """
    tree = ast.parse(path.read_text(encoding="utf-8"), filename=str(path))
    names: list[str] = []
    for node in tree.body:  # module level only — never recursed into
        if isinstance(node, ast.Import):
            names.extend(alias.name for alias in node.names)
        elif isinstance(node, ast.ImportFrom) and node.module and node.level == 0:
            names.append(node.module)
    return names


def test_core_never_imports_services_at_module_level() -> None:
    offenders: list[str] = []
    for module in _core_modules():
        for imported in _toplevel_imports(module):
            if imported == "app.services" or imported.startswith("app.services."):
                offenders.append(f"{module.relative_to(APP)} imports {imported}")

    assert offenders == [], (
        "app.core must not depend on app.services at import time:\n" + "\n".join(offenders)
    )


def test_the_composition_root_may_still_name_every_service() -> None:
    """`bootstrap.py` wires the object graph; deferring its imports is the point.

    Asserted so the rule above cannot be "satisfied" one day by emptying
    bootstrap and scattering construction across the codebase.
    """
    source = (CORE / "bootstrap.py").read_text(encoding="utf-8")

    assert "from app.services." in source
    assert "from app.services." not in "\n".join(
        line for line in source.splitlines() if not line.startswith((" ", "\t"))
    )


def test_the_plan_model_imports_without_any_service_module() -> None:
    """The concrete consequence: importing the plan must not pull in services.

    A name-only move would leave `contextualize_copy` behind in
    `app.services.outcome_provenance` and this would still fail — which is why
    the task moved it too.
    """
    import subprocess
    import sys

    probe = (
        "import sys; import app.core.sort_plan; "
        "leaked = sorted(m for m in sys.modules if m.startswith('app.services')); "
        "print(':'.join(leaked))"
    )
    result = subprocess.run(
        [sys.executable, "-c", probe],
        capture_output=True,
        text=True,
        cwd=str(APP.parent),
        check=False,
    )

    assert result.returncode == 0, result.stderr
    leaked = [name for name in result.stdout.strip().split(":") if name]
    assert leaked == [], f"importing app.core.sort_plan pulled in {leaked}"


@pytest.mark.parametrize(
    "name",
    [
        "CONTEXTUAL_COPY_FOLDER",
        "QUARANTINE_FOLDERS",
        "companion_destination",
        "copy_destination",
        "reserve_destination",
    ],
)
def test_the_moved_names_are_still_reachable_from_their_old_home(name: str) -> None:
    """The move is not a rename: every existing import keeps working."""
    import app.core.destination_paths as core_paths
    import app.services.destination as service_paths

    assert getattr(service_paths, name) is getattr(core_paths, name)
