#!/usr/bin/env bash
# 启动服务时：全局关闭 ADB 并持续压制，保证 WebUSB 独占设备。
# 终止服务时：恢复本地 ADB 守护进程。
# macOS/Linux 专用。运行: npm run dev:suppress-adb（默认 npm run dev 不再动本地 ADB）

set -e
KILLER_PID=""

cleanup() {
  if [[ -n "$KILLER_PID" ]]; then
    kill "$KILLER_PID" 2>/dev/null || true
    wait "$KILLER_PID" 2>/dev/null || true
  fi
  adb start-server 2>/dev/null || true
  echo "已恢复本地 ADB 服务，可执行 adb devices 验证。"
}
trap cleanup EXIT INT TERM

# 先关掉当前机器上的 ADB 守护进程（全局生效）
adb kill-server 2>/dev/null || true
echo "已关闭本地 ADB 守护进程（全局生效）。"

# 后台循环：服务运行期间持续 kill，防止其他终端启动 adb 抢占设备
( while true; do adb kill-server 2>/dev/null; sleep 3; done ) &
KILLER_PID=$!

echo "服务运行期间将持续压制 ADB，其他终端也无法占用设备。退出服务后将自动恢复 ADB。"
npx vite --host 127.0.0.1
