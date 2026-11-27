@echo off
chcp 65001 >nul
setlocal
where node >nul 2>nul
if errorlevel 1 (
  echo [ERROR] Node.js ^>= 22.5 is required.
  pause
  exit /b 1
)
if "%~1"=="" (
  node "%~dp0setup.mjs" --menu
) else (
  node "%~dp0setup.mjs" %*
)
echo.
pause
