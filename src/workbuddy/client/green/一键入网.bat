@echo off
chcp 65001 >nul
cd /d %~dp0
echo [1/2] Checking Python...
python --version >nul 2>&1
if errorlevel 1 goto nopython
echo [2/2] Starting green mode (auto-bootstrap on first run)...
python guardian.py
pause
exit /b 0

:nopython
echo [ERROR] Python not found. Install from python.org with "Add to PATH" checked, then rerun.
pause
exit /b 1
