!include "nsDialogs.nsh"
!include "LogicLib.nsh"
!include "MUI2.nsh"

!ifndef BUILD_UNINSTALLER
  Var DesktopShortcutCheckbox
  Var DesktopShortcutRequested

  !macro customInit
    StrCpy $DesktopShortcutRequested ${BST_CHECKED}
  !macroend

  !macro customPageAfterChangeDir
    Page custom DesktopShortcutPageCreate DesktopShortcutPageLeave
  !macroend

  Function DesktopShortcutPageCreate
    ${If} ${Silent}
      Abort
    ${EndIf}
    nsDialogs::Create 1018
    Pop $0
    ${If} $0 == error
      Abort
    ${EndIf}
    !insertmacro MUI_HEADER_TEXT "安装选项" "选择安装完成后要创建的快捷方式。"
    ${NSD_CreateCheckbox} 0 16u 100% 18u "在桌面创建“乐评寻踪”快捷方式"
    Pop $DesktopShortcutCheckbox
    ${NSD_SetState} $DesktopShortcutCheckbox $DesktopShortcutRequested
    nsDialogs::Show
  FunctionEnd

  Function DesktopShortcutPageLeave
    ${NSD_GetState} $DesktopShortcutCheckbox $DesktopShortcutRequested
  FunctionEnd

  !macro customInstall
    ${If} $DesktopShortcutRequested != ${BST_CHECKED}
      Delete "$newDesktopLink"
    ${EndIf}
  !macroend
!endif
