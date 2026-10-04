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
    guard = Path(__file__).resolve().parents[1] / "frontend/src-tauri/installer/path-guard.nsh"
    with tempfile.TemporaryDirectory(prefix="mediasorter-nsis-") as scratch:
        directory = Path(scratch)
        executable = directory / "guard.exe"
        trace = directory / "destination.txt"
        source = directory / "guard.nsi"
        source.write_text(
            f'''Unicode true
SilentInstall normal
Name "MediaSorter disposable directory guard regression"
OutFile "{executable}"
InstallDir "$TEMP\\MediaSorter"
!include MUI2.nsh
!define MediaSorterUninstallKey "Software\\FileworksGuardFixture\\{uuid.uuid4()}"
!include "{guard}"
!define MULTIUSER_EXECUTIONLEVEL Highest
!define MULTIUSER_INSTALLMODE_INSTDIR "MediaSorter"
!define MULTIUSER_USE_PROGRAMFILES64
!define MULTIUSER_NOUNINSTALL
!define MULTIUSER_INSTALLMODE_FUNCTION RestorePreviousInstallLocation
!define MULTIUSER_PAGE_CUSTOMFUNCTION_SHOW FixtureChooseScope
!include MultiUser.nsh
; This fixture only chooses paths and writes its trace, never installs. Keep its
; process unelevated while exercising both scope-page branches without UAC.
RequestExecutionLevel user
!insertmacro MULTIUSER_PAGE_INSTALLMODE
!define MUI_PAGE_CUSTOMFUNCTION_SHOW FixtureReadDirectory
!insertmacro MUI_PAGE_DIRECTORY
!insertmacro MUI_PAGE_INSTFILES
!insertmacro MUI_LANGUAGE "English"
Function .onInit
  !insertmacro MULTIUSER_INIT
  StrCpy $MultiUser.Privileges "Admin"
  Call MultiUser.InstallMode.CurrentUser
FunctionEnd
Function RestorePreviousInstallLocation
  ${{GetOptions}} $CMDLINE "/REMEMBER_PROGRAMFILES" $0
  ${{IfNot}} ${{Errors}}
    StrCpy $INSTDIR "$PROGRAMFILES64"
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/REMEMBER_USERPROGRAMS" $0
  ${{IfNot}} ${{Errors}}
    GetKnownFolderPath $INSTDIR {{5CD7AEE2-2219-4A67-B85D-6C9CE15660CB}}
    ${{If}} $INSTDIR == ""
      StrCpy $INSTDIR "$LOCALAPPDATA\\Programs"
    ${{EndIf}}
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/REMEMBER_FALLBACKPROGRAMS" $0
  ${{IfNot}} ${{Errors}}
    StrCpy $INSTDIR "$LOCALAPPDATA\\Programs"
  ${{EndIf}}
  ${{GetOptions}} $CMDLINE "/REMEMBER_SAFE" $0
  ${{IfNot}} ${{Errors}}
    StrCpy $INSTDIR "$EXEDIR\\custom\\MediaSorter"
  ${{EndIf}}
FunctionEnd
Function FixtureChooseScope
  ${{GetOptions}} $CMDLINE "/ALLUSERS" $0
  ${{IfNot}} ${{Errors}}
    SendMessage $MultiUser.InstallModePage.AllUsers ${{BM_SETCHECK}} ${{BST_CHECKED}} 0
    SendMessage $MultiUser.InstallModePage.CurrentUser ${{BM_SETCHECK}} ${{BST_UNCHECKED}} 0
  ${{Else}}
    SendMessage $MultiUser.InstallModePage.AllUsers ${{BM_SETCHECK}} ${{BST_UNCHECKED}} 0
    SendMessage $MultiUser.InstallModePage.CurrentUser ${{BM_SETCHECK}} ${{BST_CHECKED}} 0
  ${{EndIf}}
  ${{NSD_CreateTimer}} FixtureNext 50
FunctionEnd
Function FixtureNext
  ${{NSD_KillTimer}} FixtureNext
  SendMessage $HWNDPARENT ${{WM_COMMAND}} 1 0
FunctionEnd
Function FixtureReadDirectory
  ${{NSD_GetText}} $mui.DirectoryPage.Directory $0
  FileOpen $1 "$EXEDIR\\destination.txt" w
  FileWriteUTF16LE $1 "$MultiUser.InstallMode|$0"
  FileClose $1
  SetErrorLevel 0
  Quit ; Read the actual displayed text; never reach an installation section.
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
            (os.environ["PROGRAMFILES"], 2),
            (os.environ["PROGRAMFILES"] + "\\", 2),
            (os.environ["LOCALAPPDATA"] + "\\Programs", 2),
            (str(directory / "shared folder"), 2),
            (str(directory / "folder with spaces ü" / "MediaSorter"), 0),
            (str(directory / "MediaSorter") + "\\", 0),
        ]
        for destination, expected, remembered in [
            (destination, expected, remembered)
            for remembered in (False, True)
            for destination, expected in cases
        ]:
            trace.unlink(missing_ok=True)
            # NSIS requires /D= last and unquoted, even when the path has spaces.
            command = f'"{executable}" /S'
            if remembered:
                command += " /REMEMBER_PROGRAMFILES"
            if destination is not None:
                command += f" /D={destination}"
            result = subprocess.run(command, executable=str(executable), timeout=20, check=False)
            if result.returncode != expected:
                raise RuntimeError(
                    f"Destination {destination!r}: exit {result.returncode}, expected {expected}"
                )
            if expected == 2 and trace.exists():
                raise RuntimeError("Rejected destination reached the payload section")
            if expected == 0:
                effective = trace.read_text(encoding="utf-16-le")
                if destination is not None and Path(effective) != Path(destination):
                    raise RuntimeError(f"Explicit destination was replaced: {effective!r}")
                if Path(effective).name.casefold() != "mediasorter":
                    raise RuntimeError(f"Unsafe effective destination: {effective!r}")
            print(
                f"NSIS MultiUser destination {destination!r}, remembered={remembered}: "
                f"exit {expected} OK"
            )
        trace.unlink(missing_ok=True)
        result = subprocess.run(
            [str(executable), "/S", "/REMEMBER_PROGRAMFILES"],
            timeout=20,
            check=False,
        )
        if result.returncode != 0:
            raise RuntimeError(
                "A remembered Programs root did not default to its MediaSorter "
                f"subfolder: exit {result.returncode}"
            )
        effective = trace.read_text(encoding="utf-16-le")
        expected = Path(os.environ["PROGRAMFILES"]) / "MediaSorter"
        if Path(effective) != expected:
            raise RuntimeError(f"Remembered Programs default is {effective!r}")
        print("NSIS remembered Programs default: MediaSorter subfolder OK")
        gui_cases = [
            ([], "CurrentUser", None),
            (["/ALLUSERS"], "AllUsers", expected),
            (["/REMEMBER_PROGRAMFILES"], "CurrentUser", expected),
            (["/ALLUSERS", "/REMEMBER_PROGRAMFILES"], "AllUsers", expected),
            (["/REMEMBER_USERPROGRAMS"], "CurrentUser", None),
            (
                ["/REMEMBER_FALLBACKPROGRAMS"],
                "CurrentUser",
                Path(os.environ["LOCALAPPDATA"]) / "Programs/MediaSorter",
            ),
            (["/REMEMBER_SAFE"], "CurrentUser", directory / "custom/MediaSorter"),
            (
                ["/ALLUSERS", "/REMEMBER_SAFE"],
                "AllUsers",
                directory / "custom/MediaSorter",
            ),
        ]
        startup = subprocess.STARTUPINFO()
        startup.dwFlags |= subprocess.STARTF_USESHOWWINDOW
        startup.wShowWindow = 0
        for options, scope, selected in gui_cases:
            trace.unlink(missing_ok=True)
            subprocess.run(
                [str(executable), *options],
                startupinfo=startup,
                timeout=20,
                check=True,
            )
            actual_scope, displayed = trace.read_text(encoding="utf-16-le").split("|", 1)
            if actual_scope != scope or Path(displayed).name != "MediaSorter":
                raise RuntimeError(f"Directory page {options}: {actual_scope}|{displayed}")
            if selected is not None and Path(displayed) != selected:
                raise RuntimeError(f"Directory page default changed: {displayed!r}")
            print(f"NSIS displayed {scope} directory {options}: MediaSorter default OK")


if __name__ == "__main__":
    main()
