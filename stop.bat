@echo off
setlocal EnableExtensions
set "PORT=5000"

echo Stopping process listening on port %PORT% ...

set "KILLED=0"
for /f "tokens=5" %%P in ('netstat -ano ^| findstr ":%PORT% " ^| findstr /I "LISTENING"') do (
  if not "%%P"=="0" (
    echo Killing PID %%P
    taskkill /F /PID %%P >nul 2>&1
    if not errorlevel 1 set "KILLED=1"
  )
)

if "%KILLED%"=="0" (
  echo No LISTENING process found on port %PORT%.
) else (
  echo Done.
)

endlocal
pause
