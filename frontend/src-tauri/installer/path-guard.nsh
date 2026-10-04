; Shared roots must never become an application installation/uninstall directory.
; Keep Tauri's standard installer; enforce a dedicated MediaSorter leaf directory.
!include LogicLib.nsh
!include FileFunc.nsh

!macro MediaSorterRequireDirectory DIRECTORY MESSAGE
  Push $R8
  Push $R9
  ; GetFullPathName returns empty for a not-yet-created directory on some hosts.
  ; Check the selected leaf without requiring the destination to already exist.
  StrCpy $R8 "${DIRECTORY}"
  ${Do}
    StrCpy $R9 $R8 1 -1
    ${If} $R9 != "\"
    ${AndIf} $R9 != "/"
      ${ExitDo}
    ${EndIf}
    StrCpy $R8 $R8 -1
  ${Loop}
  ${GetFileName} "$R8" $R9
  ${If} $R9 != "MediaSorter"
    DetailPrint "Choose a dedicated MediaSorter folder, for example C:\Program Files\MediaSorter."
    MessageBox MB_OK|MB_ICONSTOP "${MESSAGE}" /SD IDOK
    SetErrorLevel 2
    Quit
  ${EndIf}
  Pop $R9
  Pop $R8
!macroend

!macro MediaSorterCheckDirectory
  !insertmacro MediaSorterRequireDirectory "$INSTDIR" "MediaSorter requires its own folder named MediaSorter. Select that subfolder; installing into a shared folder is unsafe."
!macroend

; Tauri's maintenance page can execute a previous uninstaller before PREINSTALL.
; This invisible page precedes its pages. PREINSTALL repeats the check for /S.
; A fixture may override the key; production uses the stable Tauri uninstall key.
!ifndef MediaSorterUninstallKey
  !define MediaSorterUninstallKey "Software\Microsoft\Windows\CurrentVersion\Uninstall\MediaSorter"
!endif

!macro MediaSorterCheckLegacy HIVE
  ReadRegStr $R7 ${HIVE} "${MediaSorterUninstallKey}" "UninstallString"
  ${If} $R7 != ""
    ReadRegStr $R8 ${HIVE} "${MediaSorterUninstallKey}" "InstallLocation"
    ; Tauri stores InstallLocation in quotes. Accept that standard representation.
    StrCpy $R9 $R8 1
    ${If} $R9 == '$\"'
      StrCpy $R8 $R8 "" 1
      StrCpy $R9 $R8 1 -1
      ${If} $R9 == '$\"'
        StrCpy $R8 $R8 -1
      ${EndIf}
    ${EndIf}
    !insertmacro MediaSorterRequireDirectory "$R8" "A previous MediaSorter installation has an unsafe or unknown location. Back up application state and review that installation's files before removing it. This installer will not run its old uninstaller. See docs/install.md."
    ${If} $R7 != '$\"$R8\uninstall.exe$\"'
    ${AndIf} $R7 != "$R8\uninstall.exe"
      MessageBox MB_OK|MB_ICONSTOP "The previous MediaSorter uninstall command is nonstandard. Review it before updating; this installer will not execute it." /SD IDOK
      SetErrorLevel 2
      Quit
    ${EndIf}
  ${EndIf}
!macroend

Function MediaSorterCheckLegacyInstallations
  Push $R7
  Push $R8
  Push $R9
  !insertmacro MediaSorterCheckLegacy HKCU
  !insertmacro MediaSorterCheckLegacy HKLM
  Pop $R9
  Pop $R8
  Pop $R7
FunctionEnd

Page custom MediaSorterLegacyPreflight
Function MediaSorterLegacyPreflight
  Call MediaSorterCheckLegacyInstallations
  Abort ; No visible page when the preflight succeeds.
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call MediaSorterCheckLegacyInstallations
  !insertmacro MediaSorterCheckDirectory
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MediaSorterCheckDirectory
!macroend
