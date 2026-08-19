@echo off
chcp 65001 >nul
set PYTHONUTF8=1
set PYTHONIOENCODING=utf-8
title HitVgo Local Agent
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] Python not found. Install Python 3.10+ and check "Add to PATH".
  echo Download: https://www.python.org/downloads/
  pause
  exit /b 1
)

if not exist ".venv\Scripts\python.exe" (
  echo [1/2] Creating venv...
  python -m venv .venv
  if errorlevel 1 (
    echo [ERROR] Failed to create venv
    pause
    exit /b 1
  )
)

if not exist "duck_decode.py" (
  echo [ERROR] Missing duck_decode.py - please re-download the agent zip.
  pause
  exit /b 1
)

echo Installing/updating dependencies...
".venv\Scripts\python.exe" -m pip install -r requirements.txt
if errorlevel 1 (
  echo [ERROR] pip install failed
  pause
  exit /b 1
)

echo.
echo Starting HitVgo local agent...
echo Author: Geek007  https://hitvgo.geek007.com
echo Listening on 0.0.0.0:39281 (all interfaces). Local: http://127.0.0.1:39281
echo After ready, go back to the website and click "Check connection".
echo.
if not defined VFLOW_AGENT_HOST set VFLOW_AGENT_HOST=0.0.0.0
".venv\Scripts\python.exe" app.py
if errorlevel 1 (
  echo.
  echo [ERROR] Agent exited unexpectedly
  pause
)