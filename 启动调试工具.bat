@echo off
chcp 65001 >nul
cd /d "%~dp0"

where node >nul 2>nul
if errorlevel 1 (
  echo 未检测到 Node.js，请先安装 LTS 版本：https://nodejs.org/
  echo 安装完成后请重新双击本文件。
  pause
  exit /b 1
)

if not exist node_modules (
  echo 首次运行，正在安装依赖，请稍候…
  call npm install
  if errorlevel 1 (
    echo 依赖安装失败，请检查网络后重试。
    pause
    exit /b 1
  )
)

set ANDROID_DEBUG_TOOLS_OPEN_BROWSER=1
echo 正在启动安卓调试工具，请勿关闭本窗口；浏览器将自动打开。
echo ————————————————————————————————————————
call npm start
if errorlevel 1 (
  echo ————————————————————————————————————————
  echo 启动过程异常结束。
  pause
  exit /b 1
)
