"""Compile and run the real directory hook with NSIS's MultiUser initialization.

Uses no application payload or product registry keys. The supplied compiler must
be the NSIS tool already used by Tauri; this script never downloads executables.
"""

import argparse
import os
import subprocess
import tempfile
import uuid
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--makensis", type=Path, required=True)
    args = parser.parse_args()
    if os.name != "nt":
        parser.error("the compiled NSIS regression requires Windows")
    guard = (
        Path(__file__).resolve().parents[1]
        / "frontend/src-tauri/installer/path-guard.nsh"
    )
    with tempfile.TemporaryDirectory(prefix="mediasorter-nsis-") as scratch:
        directory = Path(scratch)
        executable = directory / "guard.exe"
        trace = directory / "destination.txt"
        source = directory / "guard.nsi"
        source.write_text(
            f'''Unicode true
SilentInstall silent
Name "MediaSorter disposable directory guard regression"
OutFile "{executable}"
InstallDir "$TEMP\\MediaSorter"
!define MULTIUSER_EXECUTIONLEVEL User
!define MULTIUSER_INSTALLMODE_INSTDIR "MediaSorter"
!define MULTIUSER_NOUNINSTALL
!include MultiUser.nsh
!define MediaSorterUninstallKey "Software\\FileworksGuardFixture\\{uuid.uuid4()}"
!include "{guard}"
Function .onInit
  !insertmacro MULTIUSER_INIT
FunctionEnd
Section
  !insertmacro NSIS_HOOK_PREINSTALL
  FileOpen $0 "$EXEDIR\\destination.txt" w
  FileWriteUTF16LE $0 "$INSTDIR"
  FileClose $0
  SetErrorLevel 0
SectionEnd
''',
            encoding="utf-8",
        )
        subprocess.run([str(args.makensis.resolve()), "/V2", str(source)], check=True)
        cases = [
            (None, 0),
            ("", 2),
            ("MediaSorter", 2),
            ("C:MediaSorter", 2),
            (os.environ["ProgramFiles"], 2),
            (os.environ["ProgramFiles"] + "\\", 2),
            (str(directory / "shared folder"), 2),
            (str(directory / "folder with spaces ü" / "MediaSorter"), 0),
            (str(directory / "MediaSorter") + "\\", 0),
        ]
        for destination, expected in cases:
            trace.unlink(missing_ok=True)
            # NSIS requires /D= last and unquoted, even when the path has spaces.
            command = f'"{executable}" /S'
            if destination is not None:
                command += f" /D={destination}"
            result = subprocess.run(
                command, executable=str(executable), timeout=20, check=False
            )
            if result.returncode != expected:
                raise RuntimeError(
                    f"Destination {destination!r}: exit {result.returncode}, "
                    f"expected {expected}"
                )
            if expected == 2 and trace.exists():
                raise RuntimeError("Rejected destination reached the payload section")
            if expected == 0:
                effective = trace.read_text(encoding="utf-16-le")
                if destination is not None and Path(effective) != Path(destination):
                    raise RuntimeError(
                        f"Explicit destination was replaced: {effective!r}"
                    )
                if Path(effective).name.casefold() != "mediasorter":
                    raise RuntimeError(f"Unsafe effective destination: {effective!r}")
            print(f"NSIS MultiUser destination {destination!r}: exit {expected} OK")


if __name__ == "__main__":
    main()
