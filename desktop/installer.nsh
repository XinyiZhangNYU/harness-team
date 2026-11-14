; Custom NSIS steps for the Windows installer (electron-builder "nsis.include").
; Settings -> open at login writes a value named after the app's AppUserModelId to the user's Run key (Electron's
; app.setLoginItemSettings). Removing the app removes it too; an update (which runs the old uninstaller first) keeps it.
!macro customUnInstall
  ${ifNot} ${isUpdated}
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Run" "${APP_ID}"
    DeleteRegValue HKCU "Software\Microsoft\Windows\CurrentVersion\Explorer\StartupApproved\Run" "${APP_ID}"
  ${endIf}
!macroend
