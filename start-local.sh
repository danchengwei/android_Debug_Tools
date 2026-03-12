#!/usr/bin/env bash
# 使用本地 ADB 启动服务

set -e

echo "使用本地 ADB 启动服务..."

# 启动 ADB 服务器
node adb-server.js &
ADB_SERVER_PID=$!
echo "ADB 服务器已启动，PID: $ADB_SERVER_PID"

# 启动 Scrcpy 服务器
node scrcpy-server.js &
SCRCPY_SERVER_PID=$!
echo "Scrcpy 服务器已启动，PID: $SCRCPY_SERVER_PID"

# 等待服务器启动
sleep 3

# 启动 Vite 开发服务器
npx vite --host 127.0.0.1

# 当 Vite 开发服务器退出时，终止所有后台服务
echo "正在停止服务..."
kill $ADB_SERVER_PID 2>/dev/null
kill $SCRCPY_SERVER_PID 2>/dev/null
wait $ADB_SERVER_PID 2>/dev/null
wait $SCRCPY_SERVER_PID 2>/dev/null
echo "服务已停止"
