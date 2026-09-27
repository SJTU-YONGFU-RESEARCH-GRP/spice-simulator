@echo off
setlocal

where node >nul 2>nul
if errorlevel 1 (
    echo [preview] Node.js was not found in PATH.
    echo [preview] Please install Node.js and restart the terminal.
    pause
    exit /b 1
)

echo [preview] Starting local server on http://127.0.0.1:8080/spice-simulator/
echo [preview] Press Ctrl+C to stop.
node "%~dp0scripts\serve-local.mjs" %*