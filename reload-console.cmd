@echo off
powershell.exe -NoProfile -File "%~dp0scripts\reload-console.ps1"
if errorlevel 1 pause
