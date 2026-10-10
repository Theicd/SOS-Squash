@echo off
setlocal EnableExtensions
cd /d "%~dp0"

title SOS Squash Lab

where node >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Node.js not found. Install from https://nodejs.org and try again.
  pause
  exit /b 1
)

if not exist "index.html" (
  echo [ERROR] index.html missing in %CD%
  pause
  exit /b 1
)

if not exist "vendor\mediabunny.min.mjs" (
  echo [ERROR] vendor\mediabunny.min.mjs missing. Run: npm install
  pause
  exit /b 1
)

echo.
echo  Starting SOS Squash Lab locally...
echo  Browser will open at http://127.0.0.1:8787/
echo  Close this window or press Ctrl+C to stop.
echo.

node "%~dp0serve-lab.mjs" --port 8787
set ERR=%ERRORLEVEL%
if not "%ERR%"=="0" (
  echo.
  echo [ERROR] Server exited with code %ERR%
  pause
)
exit /b %ERR%
