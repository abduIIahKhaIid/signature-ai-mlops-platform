@echo off
setlocal
cd /d "%~dp0dataset_dashboard"
where node >nul 2>nul
if errorlevel 1 (
  echo Node.js 20 or newer is required.
  echo Install Node.js, then run this file again.
  pause
  exit /b 1
)
start "Signature Dataset Dashboard Server" cmd /k node server.mjs
timeout /t 2 /nobreak >nul
start "" "http://127.0.0.1:4173"
