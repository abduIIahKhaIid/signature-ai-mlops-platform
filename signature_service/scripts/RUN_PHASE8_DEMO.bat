@echo off
rem Phase 8: send every monitoring scenario to the EC2 API so it shows up in Logfire (about 2 minutes).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_phase8_demo.ps1"
pause
