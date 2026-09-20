@echo off
setlocal
set "NODE=C:\Users\dell\.workbuddy\binaries\node\versions\22.22.2-3\node.exe"
if not exist "%NODE%" (
  echo [preview] node not found at: %NODE%
  echo [preview] The managed Node.js path may have changed. Update NODE in this file.
  pause
  exit /b 1
)
echo [preview] Starting local server on http://127.0.0.1:8080/spice-simulator/
echo [preview] Press Ctrl+C to stop.
"%NODE%" "%~dp0scripts\serve-local.mjs" %*
