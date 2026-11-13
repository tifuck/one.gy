; ONE.GY: put the bundled onegy binary (CLI + sync engine, resources\engine)
; on the user PATH, and take it off again on uninstall (not on updates).
; PowerShell edits the raw REG_EXPAND_SZ value entry by entry, so a long PATH
; is never truncated by NSIS string limits and %VAR% entries stay unexpanded;
; the throwaway SetEnvironmentVariable broadcasts the change to new terminals.
!macro onegyPath action
  System::Call 'Kernel32::SetEnvironmentVariable(t, t)i ("ONEGY_ENGINE_DIR", "$INSTDIR\resources\engine").r0'
  nsExec::Exec `"$SYSDIR\WindowsPowerShell\v1.0\powershell.exe" -NoProfile -NonInteractive -ExecutionPolicy Bypass -Command "$$d = $$env:ONEGY_ENGINE_DIR; $$old = @((Get-Item 'HKCU:\Environment').GetValue('Path', '', 'DoNotExpandEnvironmentNames') -split ';' | Where-Object { $$_ }); $$new = @($$old | Where-Object { $$_ -ne $$d }); if ('${action}' -eq 'add') { $$new += $$d }; if (($$new -join ';') -ne ($$old -join ';')) { Set-ItemProperty 'HKCU:\Environment' Path ($$new -join ';') -Type ExpandString; [Environment]::SetEnvironmentVariable('ONEGY_PATH_SYNC', '1', 'User'); [Environment]::SetEnvironmentVariable('ONEGY_PATH_SYNC', $$null, 'User') }"`
  Pop $0
!macroend

!macro customInstall
  !insertmacro onegyPath add
!macroend

!macro customUnInstall
  ${ifNot} ${isUpdated}
    !insertmacro onegyPath remove
  ${endIf}
!macroend
