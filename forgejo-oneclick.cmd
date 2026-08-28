@echo off
setlocal EnableExtensions EnableDelayedExpansion
set "SCRIPT=%~dp0ops\forgejo\bootstrap.ps1"
if "%~1"=="" (
  set "ACTION=install"
) else (
  set "ACTION=%~1"
  shift
)
if /I "%ACTION%"=="restore" (
  if "%~1"=="" (
    echo Usage: forgejo-oneclick.cmd restore ^<backup-id^> 1>&2
    exit /b 2
  )
  powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action restore -BackupId "%~1"
  exit /b !ERRORLEVEL!
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action "%ACTION%" %*
exit /b %ERRORLEVEL%
