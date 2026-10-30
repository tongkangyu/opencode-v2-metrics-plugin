@echo off
setlocal
set "SCRIPT=%USERPROFILE%\.config\opencode\uninstallers\opencode-v2-metrics-plugin\uninstall.ps1"
if not exist "%SCRIPT%" (
  echo OpenCode V2 Metrics plugin is not installed.
  exit /b 1
)
where pwsh.exe >nul 2>nul
if %ERRORLEVEL% EQU 0 (
  pwsh.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
) else (
  powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%SCRIPT%" %*
)
exit /b %ERRORLEVEL%
