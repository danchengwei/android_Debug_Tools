#!/usr/bin/env bash
# 使用本地 ADB 启动服务

set -e

echo "使用本地 ADB 启动服务..."

# 释放端口和进程
echo "释放端口和进程..."
pkill -f 'node.*adb-server.js|node.*scrcpy-server.js' || true
pkill -f scrcpy || true

# 检查并释放端口 13377
if lsof -i :13377 > /dev/null 2>&1; then
    echo "端口 13377 被占用，正在释放..."
    lsof -ti :13377 | xargs kill -9 || true
    sleep 2
fi

# 检查并释放端口 3003
if lsof -i :3003 > /dev/null 2>&1; then
    echo "端口 3003 被占用，正在释放..."
    lsof -ti :3003 | xargs kill -9 || true
    sleep 2
fi

# 启动 ADB 服务器（仅启动 HTTP 桥接服务，不影响本地 ADB 守护进程）
echo "启动 ADB HTTP 桥接服务..."
node adb-server.js &
ADB_SERVER_PID=$!
echo "ADB HTTP 桥接服务已启动，PID: $ADB_SERVER_PID"

# 等待 ADB HTTP 服务启动
sleep 2

# 启动 Scrcpy 服务器
echo "启动 Scrcpy 服务器..."
node scrcpy-server.js &
SCRCPY_SERVER_PID=$!
echo "Scrcpy 服务器已启动，PID: $SCRCPY_SERVER_PID"

# 等待服务器启动
sleep 3

# 检查 Scrcpy 服务器是否成功启动
if ! lsof -i :13377 > /dev/null 2>&1; then
    echo "错误：Scrcpy 服务器启动失败，端口 13377 未被占用"
    kill $ADB_SERVER_PID 2>/dev/null
    exit 1
fi

echo "所有服务启动成功！"

# 启动 Vite 开发服务器
echo "启动 Vite 开发服务器..."
npx vite

# 当 Vite 开发服务器退出时，终止所有后台服务
echo "正在停止服务..."
kill $ADB_SERVER_PID 2>/dev/null
kill $SCRCPY_SERVER_PID 2>/dev/null
wait $ADB_SERVER_PID 2>/dev/null
wait $SCRCPY_SERVER_PID 2>/dev/null
echo "服务已停止"
