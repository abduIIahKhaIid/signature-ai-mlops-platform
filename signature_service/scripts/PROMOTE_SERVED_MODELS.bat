@echo off
rem Create the production aliases from the models the API serves right now.
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0promote_served_models.ps1"
pause
