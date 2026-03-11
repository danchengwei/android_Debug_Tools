#!/usr/bin/env bash
# 使用本地 ADB 启动服务

set -e

echo "使用本地 ADB 启动服务..."

# 启动 ADB 服务器
node adb-server.js &
ADB_SERVER_PID=$!
echo "ADB 服务器已启动，PID: $ADB_SERVER_PID"

# 等待 ADB 服务器启动
sleep 2

# 启动 Vite 开发服务器
npx vite --host 127.0.0.1

# 当 Vite 开发服务器退出时，终止 ADB 服务器
echo "正在停止 ADB 服务器..."
kill $ADB_SERVER_PID 2>/dev/null
wait $ADB_SERVER_PID 2>/dev/null
echo "ADB 服务器已停止"