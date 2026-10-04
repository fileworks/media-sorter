; Shared roots must never become an application installation/uninstall directory.
; Keep Tauri's standard installer; enforce a dedicated MediaSorter leaf directory.
!include LogicLib.nsh
!include FileFunc.nsh

; MultiUser restores remembered locations again when the scope page is left.
; Correct its default before the directory page, without replacing Tauri's UI.
!define MULTIUSER_PAGE_CUSTOMFUNCTION_LEAVE MediaSorterScopePreflight

Function MediaSorterPrepareDirectory
  Push $R8
  Push $R9
  StrCpy $R8 $INSTDIR
  ${Do}
    StrCpy $R9 $R8 1 -1
    ${If} $R9 != "\"
    ${AndIf} $R9 != "/"
      ${ExitDo}
    ${EndIf}
    StrCpy $R8 $R8 -1
  ${Loop}
  GetKnownFolderPath $R9 {5CD7AEE2-2219-4A67-B85D-6C9CE15660CB} ; UserProgramFiles
  ${If} $R8 == "$PROGRAMFILES"
  ${OrIf} $R8 == "$PROGRAMFILES64"
    StrCpy $INSTDIR "$R8\MediaSorter"
  ${ElseIf} $R9 != ""
  ${AndIf} $R8 == $R9
    StrCpy $INSTDIR "$R8\MediaSorter"
  ${EndIf}
  Pop $R9
  Pop $R8
FunctionEnd

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

Function MediaSorterCheckRequestedDirectory
  Push $R7
  Push $R8
  ; NSIS removes /D= from $CMDLINE, and MultiUser initialization replaces
  ; $INSTDIR. Read the original request before checking the effective directory.
  System::Call 'kernel32::GetCommandLineW() w .r17'
  ${GetOptionsS} $R7 "/D=" $R8
  ${IfNot} ${Errors}
    ; Only absolute drive or UNC paths are valid NSIS /D= destinations.
    ${GetRoot} $R8 $R7
    ${If} $R7 == ""
      StrCpy $R8 ""
    ${Else}
      StrCpy $R7 $R7 2
      ${If} $R7 != "\\"
        StrCpy $R7 $R8 1 2
        ${If} $R7 != "\"
          StrCpy $R8 ""
        ${EndIf}
      ${EndIf}
    ${EndIf}
    !insertmacro MediaSorterRequireDirectory "$R8" "The /D= destination must be a dedicated folder named MediaSorter. Installing into a shared folder is unsafe."
    ; Silent deployments have no directory page. Restore their explicit target
    ; after MultiUser initialization, before Tauri sets its output directory.
    ${If} ${Silent}
      StrCpy $INSTDIR $R8
    ${EndIf}
  ${EndIf}
  Pop $R8
  Pop $R7
FunctionEnd

Function MediaSorterScopePreflight
  Call MediaSorterCheckLegacyInstallations
  Call MediaSorterCheckRequestedDirectory
  Call MediaSorterPrepareDirectory
FunctionEnd

; This hidden section precedes Tauri's WebView2 and payload sections, including
; in silent mode where custom pages are skipped. Keep the standard template.
Section -MediaSorterPreflight
  Call MediaSorterScopePreflight
  !insertmacro MediaSorterCheckDirectory
SectionEnd

Page custom MediaSorterLegacyPreflight
Function MediaSorterLegacyPreflight
  Call MediaSorterScopePreflight
  Abort ; No visible page when the preflight succeeds.
FunctionEnd

!macro NSIS_HOOK_PREINSTALL
  Call MediaSorterCheckLegacyInstallations
  !insertmacro MediaSorterCheckDirectory
!macroend

!macro NSIS_HOOK_PREUNINSTALL
  !insertmacro MediaSorterCheckDirectory
!macroend
