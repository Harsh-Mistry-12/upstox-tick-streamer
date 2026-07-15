@echo off
echo ==========================================
echo  UpstoxPro - Option Chain Web Application
echo ==========================================

cd /d "%~dp0"

echo  Activating virtual environment...
call "%~dp0..\\.venv\\Scripts\\activate.bat"

if errorlevel 1 (
    echo  ERROR: Could not activate .venv. Make sure it exists at:
    echo         %~dp0..\.venv
    pause
    exit /b 1
)

echo  Virtual environment active!
echo ==========================================
echo  Local:    http://localhost:5000
echo ==========================================
echo.

python app.py
pause
