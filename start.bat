@echo off
chcp 65001 >nul
cd /d "%~dp0"
echo ⚒️ EnglishForge 启动中...
if not exist node_modules (
  echo 首次运行，安装依赖中...
  call npm install
)
start "" http://localhost:4173
call npx vite preview --port 4173 --strictPort
