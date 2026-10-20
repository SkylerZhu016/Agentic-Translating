@echo off
setlocal
if defined NODE_BINARY (
  set "QUALITY_NODE=%NODE_BINARY%"
  if not exist "%NODE_BINARY%" (
    echo NODE_BINARY does not point to an existing Node executable.
    exit /b 1
  )
) else (
  where node >nul 2>nul
  if errorlevel 1 (
    echo Node.js was not found on PATH. Install Node.js or set NODE_BINARY to its executable path.
    exit /b 1
  )
  set "QUALITY_NODE=node"
)
"%QUALITY_NODE%" "%~dp0runner.mjs" %*
exit /b %errorlevel%
