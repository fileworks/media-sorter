"""MS-13: the desktop window cannot shrink below the size every stage is checked at.

`frontend/e2e/workflow-layout.spec.ts` ("every stage fits the minimum window
size") proves each stage fits 640x480 without sideways scrolling; this pins the
shell to that size.
"""

from __future__ import annotations

import json
from pathlib import Path

TAURI_CONF = Path(__file__).resolve().parents[2] / "frontend" / "src-tauri" / "tauri.conf.json"
E2E = Path(__file__).resolve().parents[2] / "frontend" / "e2e" / "workflow-layout.spec.ts"


def test_the_window_minimum_matches_the_checked_size() -> None:
    (window,) = json.loads(TAURI_CONF.read_text(encoding="utf-8"))["app"]["windows"]

    assert (window["minWidth"], window["minHeight"]) == (640, 480)
    assert "every stage fits the minimum window size" in E2E.read_text(encoding="utf-8")
    assert "width: 640, height: 480" in E2E.read_text(encoding="utf-8")
