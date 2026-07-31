@echo off
setlocal enabledelayedexpansion
echo ==========================================
echo  UpstoxPro - Option Chain Web Application
echo ==========================================

cd /d "%~dp0"

set "VENV_DIR=%~dp0..\.venv"
set "ROOT_DIR=%~dp0.."

:: Step 1: Check if .venv exists, create if missing
if not exist "%VENV_DIR%\Scripts\activate.bat" (
    echo  Creating virtual environment in %VENV_DIR%...
    python -m venv "%VENV_DIR%"
    if errorlevel 1 (
        echo  ERROR: Failed to create Python virtual environment.
        echo         Please make sure Python is installed and added to PATH.
        pause
        exit /b 1
    )
)

:: Step 2: Activate virtual environment
echo  Activating virtual environment...
call "%VENV_DIR%\Scripts\activate.bat"

if errorlevel 1 (
    echo  ERROR: Could not activate virtual environment at %VENV_DIR%.
    pause
    exit /b 1
)

:: Step 3: Ensure .env file exists
if not exist "%ROOT_DIR%\.env" (
    if exist "%ROOT_DIR%\.env.example" (
        echo  Creating .env from .env.example...
        copy "%ROOT_DIR%\.env.example" "%ROOT_DIR%\.env" >nul
    )
)

:: Step 4: Install / verify dependencies
echo  Installing / verifying dependencies from requirements.txt...
python -m pip install -r "%~dp0requirements.txt"

if errorlevel 1 (
    echo  WARNING: Dependency installation encountered an issue.
)

echo ==========================================
echo  Local Server URL: http://localhost:5000
echo ==========================================
echo.

python app.py
pause
