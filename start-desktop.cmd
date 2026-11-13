@echo off
setlocal
cd /d "%~dp0"
if not exist ".venv\Scripts\python.exe" (
  echo Python environment missing. Follow docs\WINDOWS.md.
  exit /b 1
)
if not exist "desktop\src-tauri\target\release\easyread-desktop.exe" (
  echo Build the desktop first: cd desktop ^&^& npm ci ^&^& npm run build
  exit /b 1
)
if not defined EASYREAD_HOME set "EASYREAD_HOME=%~dp0runtime\windows-dev"
if not exist "%EASYREAD_HOME%" mkdir "%EASYREAD_HOME%"
if not exist "%EASYREAD_HOME%\config.json" copy /y "config.example.json" "%EASYREAD_HOME%\config.json" >nul
if not defined WEBVIEW2_USER_DATA_FOLDER set "WEBVIEW2_USER_DATA_FOLDER=%EASYREAD_HOME%\webview2"
set "EASYREAD_PROJECT_ROOT=%~dp0"
set "PYTHONUTF8=1"
start "EasyRead" "desktop\src-tauri\target\release\easyread-desktop.exe"
