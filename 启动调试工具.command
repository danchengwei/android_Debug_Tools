#!/bin/bash
# 双击运行（macOS）：自动安装依赖、启动全套服务并在就绪后打开浏览器，无需使用命令行或记忆网址。
set -euo pipefail
cd "$(dirname "$0")" || exit 1

# 常见安装路径 + nvm（若已安装）
export PATH="/opt/homebrew/bin:/usr/local/bin:$PATH"
if [[ -z "${NVM_DIR:-}" ]]; then
  export NVM_DIR="$HOME/.nvm"
fi
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 LTS 版本：https://nodejs.org/"
  echo "安装完成后请重新双击本文件。"
  read -r -p "按回车键关闭…" _
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "首次运行，正在安装依赖，请稍候…"
  npm install || {
    echo "依赖安装失败，请检查网络后重试。"
    read -r -p "按回车键关闭…" _
    exit 1
  }
fi

export ANDROID_DEBUG_TOOLS_OPEN_BROWSER=1
echo "正在启动安卓调试工具，请勿关闭本窗口；浏览器将自动打开。"
echo "————————————————————————————————————————"
set +e
npm start
ec=$?
set -e
if [[ "$ec" -ne 0 ]]; then
  echo "————————————————————————————————————————"
  echo "启动过程异常结束，错误代码: $ec"
  read -r -p "按回车键关闭…" _
  exit "$ec"
fi
