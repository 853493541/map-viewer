@echo off
cd /d "%~dp0"

where npm >nul 2>nul
if errorlevel 1 (
  echo npm is not available in PATH.
  echo Install Node.js and reopen terminal.
  exit /b 1
)

echo Starting local server on http://localhost:3015 ...
npm run local
