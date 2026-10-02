"""I-12: every subprocess call is bounded.

The invariant was stated as "no `shell=True`, fixed argv, timeout on every
call". The first two held repo-wide; the third did not —
`services/ai/hardware.py` ran `subprocess.check_output(["sysctl", ...])` with no
bound, and hardware detection runs during startup, so a wedged call stalled the
application rather than one feature.

An invariant stated only in prose is not enforced. This walks the AST of every
shipped module and fails on any `subprocess` call that cannot time out, so the
next one is caught when it is written rather than when it hangs.
"""

from __future__ import annotations

import ast
from pathlib import Path

APP = Path(__file__).resolve().parents[1] / "app"

#: The call forms that start a process and *can* be bounded. `Popen` is
#: deliberately excluded from the timeout rule and included in the shell rule:
#: it returns a handle rather than waiting, so the bound belongs on the
#: `communicate()`/`wait()` that follows it.
_BOUNDABLE = {"run", "check_output", "check_call", "call"}


def _shipped_modules() -> list[Path]:
    return sorted(path for path in APP.rglob("*.py") if "__pycache__" not in path.parts)


def _subprocess_calls(tree: ast.AST) -> list[tuple[str, ast.Call]]:
    """Every `subprocess.<name>(...)` call, paired with the attribute name."""
    calls: list[tuple[str, ast.Call]] = []
    for node in ast.walk(tree):
        if not isinstance(node, ast.Call):
            continue
        func = node.func
        if (
            isinstance(func, ast.Attribute)
            and isinstance(func.value, ast.Name)
            and func.value.id == "subprocess"
        ):
            calls.append((func.attr, node))
    return calls


def test_every_bounded_subprocess_call_passes_a_timeout() -> None:
    offenders: list[str] = []
    checked = 0

    for module in _shipped_modules():
        tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
        for name, call in _subprocess_calls(tree):
            if name not in _BOUNDABLE:
                continue
            checked += 1
            if not any(keyword.arg == "timeout" for keyword in call.keywords):
                offenders.append(f"{module.relative_to(APP)}:{call.lineno} subprocess.{name}")

    assert checked > 0, "the walker found no subprocess calls at all — it is not looking"
    assert offenders == [], "unbounded subprocess calls:\n" + "\n".join(offenders)


def test_no_subprocess_call_uses_a_shell() -> None:
    """The other two halves of I-12, which did already hold."""
    offenders: list[str] = []

    for module in _shipped_modules():
        tree = ast.parse(module.read_text(encoding="utf-8"), filename=str(module))
        for _name, call in _subprocess_calls(tree):
            for keyword in call.keywords:
                if keyword.arg == "shell" and not (
                    isinstance(keyword.value, ast.Constant) and keyword.value.value is False
                ):
                    offenders.append(f"{module.relative_to(APP)}:{call.lineno}")

    assert offenders == [], "subprocess calls using a shell:\n" + "\n".join(offenders)


def test_the_hardware_probe_is_bounded() -> None:
    """The specific call the invariant's prose claimed was already covered."""
    from app.services.ai import hardware

    source = Path(hardware.__file__).read_text(encoding="utf-8")

    # Anchor on the call, not on any mention: the constant's own comment names
    # `hw.memsize` too, and searching for the string alone finds that first.
    index = source.index("subprocess.check_output(")
    assert "hw.memsize" in source[index : index + 200]
    assert "timeout=" in source[index : index + 200], (
        "the sysctl probe runs during startup and must not be able to hang it"
    )
