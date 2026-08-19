@echo off
setlocal EnableExtensions
cd /d "%~dp0"

where python >nul 2>&1
if errorlevel 1 (
  echo [ERROR] python not found in PATH
  pause
  exit /b 1
)

if not exist "app.py" (
  echo [ERROR] app.py not found in: %cd%
  pause
  exit /b 1
)

echo Starting HitVgo...
echo Author: Geek007  https://hitvgo.geek007.com
echo URL: http://127.0.0.1:5000
echo Close this window or run stop.bat to stop.
echo.

python app.py
echo.
echo [INFO] app exited. code=%ERRORLEVEL%
pause
endlocal
