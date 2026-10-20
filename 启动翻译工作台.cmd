@echo off
setlocal
chcp 65001 >nul
cd /d "%~dp0"
node scripts\launch-desktop.mjs
if errorlevel 1 (
  echo.
  echo 启动遇到问题，请查看上方提示。
  echo 首次准备或更新程序后，请运行 npm run build:standalone。
  pause
)
endlocal
