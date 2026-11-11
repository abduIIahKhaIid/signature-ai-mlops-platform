@echo off
rem Phase 9: Locust stress test against the EC2 API (about 10 minutes). Keep this window open until it says FINISHED.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0run_phase9_stress_test.ps1"
pause
