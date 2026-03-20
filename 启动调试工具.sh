#!/usr/bin/env bash
# 在终端中执行：./启动调试工具.sh（首次需 chmod +x）
set -euo pipefail
cd "$(dirname "$0")" || exit 1

export PATH="/usr/local/bin:/opt/homebrew/bin:$PATH"
if [[ -z "${NVM_DIR:-}" ]]; then
  export NVM_DIR="$HOME/.nvm"
fi
if [[ -s "$NVM_DIR/nvm.sh" ]]; then
  # shellcheck source=/dev/null
  . "$NVM_DIR/nvm.sh"
fi

if ! command -v node >/dev/null 2>&1; then
  echo "未检测到 Node.js，请先安装 LTS：https://nodejs.org/"
  exit 1
fi

if [[ ! -d node_modules ]]; then
  echo "首次运行，正在安装依赖…"
  npm install
fi

export ANDROID_DEBUG_TOOLS_OPEN_BROWSER=1
echo "正在启动；就绪后将尝试用默认浏览器打开界面。"
exec npm start
