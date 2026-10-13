@echo off
chcp 65001 >nul
cd /d "%~dp0"
where node >nul 2>&1
if errorlevel 1 (
  echo Node.js가 필요합니다. https://nodejs.org 에서 설치한 뒤 다시 두 번 누르세요.
  pause
  exit /b 1
)
echo 이 폴더의 파이 연결을 GitHub에 올립니다.
node scripts\publish.js %*
if errorlevel 1 pause
