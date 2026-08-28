@echo off
setlocal
set "SCRIPT=%~dp0ops\forgejo\bootstrap.ps1"
if "%~1"=="" (
  set "ACTION=install"
) else (
  set "ACTION=%~1"
  shift
)
powershell.exe -NoLogo -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" -Action "%ACTION%" %*
exit /b %ERRORLEVEL%
