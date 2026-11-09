; Página de opções do instalador: atalhos e "executar agora", antes de instalar.
!ifndef BUILD_UNINSTALLER
  !include nsDialogs.nsh

  Var djaDesktop
  Var djaMenu
  Var djaExecutar
  Var djaChkDesktop
  Var djaChkMenu
  Var djaChkExecutar

  !macro customInit
    StrCpy $djaDesktop ${BST_CHECKED}
    StrCpy $djaMenu ${BST_CHECKED}
    StrCpy $djaExecutar ${BST_CHECKED}
  !macroend

  !macro customPageAfterChangeDir
    Page custom DjaOpcoesMostrar DjaOpcoesSair

    Function DjaOpcoesMostrar
      ; o app fica sempre numa subpasta própria: desinstalar apaga a pasta inteira
      ${GetFileName} "$INSTDIR" $0
      ${If} $0 != "${APP_FILENAME}"
        StrCpy $0 "$INSTDIR" "" -1
        ${If} $0 == "\"
          StrCpy $INSTDIR "$INSTDIR${APP_FILENAME}"
        ${Else}
          StrCpy $INSTDIR "$INSTDIR\${APP_FILENAME}"
        ${EndIf}
      ${EndIf}

      !insertmacro MUI_HEADER_TEXT "Opções de instalação" "Escolha os atalhos e o que fazer ao terminar."
      nsDialogs::Create 1018
      Pop $0
      ${If} $0 == error
        Abort
      ${EndIf}

      ${NSD_CreateLabel} 0 0 100% 22u "O DJAchat será instalado em:$\r$\n$INSTDIR"
      Pop $0
      ${NSD_CreateCheckbox} 0 34u 100% 12u "Criar atalho na área de trabalho"
      Pop $djaChkDesktop
      ${NSD_SetState} $djaChkDesktop $djaDesktop
      ${NSD_CreateCheckbox} 0 50u 100% 12u "Criar atalho no menu Iniciar"
      Pop $djaChkMenu
      ${NSD_SetState} $djaChkMenu $djaMenu
      ${NSD_CreateCheckbox} 0 74u 100% 12u "Executar o DJAchat ao concluir a instalação"
      Pop $djaChkExecutar
      ${NSD_SetState} $djaChkExecutar $djaExecutar

      GetDlgItem $0 $HWNDPARENT 1
      SendMessage $0 ${WM_SETTEXT} 0 "STR:Instalar"
      nsDialogs::Show
    FunctionEnd

    Function DjaOpcoesSair
      ${NSD_GetState} $djaChkDesktop $djaDesktop
      ${NSD_GetState} $djaChkMenu $djaMenu
      ${NSD_GetState} $djaChkExecutar $djaExecutar
    FunctionEnd
  !macroend

  ; os atalhos marcados existem e os desmarcados não, inclusive ao reinstalar
  !macro customInstall
    ${If} $djaDesktop == ${BST_CHECKED}
      ${IfNot} ${FileExists} "$newDesktopLink"
        CreateShortCut "$newDesktopLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newDesktopLink" "${APP_ID}"
      ${EndIf}
    ${Else}
      Delete "$newDesktopLink"
    ${EndIf}

    ${If} $djaMenu == ${BST_CHECKED}
      ${IfNot} ${FileExists} "$newStartMenuLink"
        CreateShortCut "$newStartMenuLink" "$appExe" "" "$appExe" 0 "" "" "${APP_DESCRIPTION}"
        ClearErrors
        WinShell::SetLnkAUMI "$newStartMenuLink" "${APP_ID}"
      ${EndIf}
    ${Else}
      Delete "$newStartMenuLink"
    ${EndIf}
    System::Call 'Shell32::SHChangeNotify(i 0x8000000, i 0, i 0, i 0)'
  !macroend

  !macro customFinishPage
    !define MUI_PAGE_CUSTOMFUNCTION_LEAVE DjaFinalSair
    !insertmacro MUI_PAGE_FINISH

    Function DjaFinalSair
      ${If} $djaExecutar == ${BST_CHECKED}
        ${StdUtils.ExecShellAsUser} $0 "$appExe" "open" ""
      ${EndIf}
    FunctionEnd
  !macroend
!endif
