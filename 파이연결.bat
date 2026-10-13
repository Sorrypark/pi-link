@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js가 필요합니다. https://nodejs.org 에서 설치한 뒤 다시 두 번 누르세요.
  pause
  exit /b 1
)
if not exist "node_modules\ssh2\package.json" (
  echo 필요한 파일을 받는 중입니다...
  call npm install --omit=dev
  if errorlevel 1 (
    pause
    exit /b 1
  )
)
call npm start
if errorlevel 1 pause
