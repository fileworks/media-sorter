"""Collect native directory lookup without probing Windows DLLs on other OSes."""

import sys

# platformdirs 4.12 imports each OS implementation behind a sys.platform branch.
# Static analysis follows every branch, including WinDLL calls on macOS. Keep
# the native implementation explicit and exclude only the unreachable Windows
# branch; this module must remain available when actually building on Windows.
native = {"win32": "windows", "darwin": "macos"}.get(sys.platform, "unix")
hiddenimports = [f"platformdirs.{native}"]
excludedimports = [] if sys.platform == "win32" else ["platformdirs.windows"]
