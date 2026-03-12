#!/usr/bin/env node
// Scrcpy WebSocket 服务器
import * as WebSocket from 'ws';
import { spawn, exec } from 'child_process';
import http from 'http';
import net from 'net';

const PORT = 9999;
const SCRCPY_PATH = '/opt/homebrew/bin/scrcpy';
let scrcpyProcess = null;
let isRunning = false;
let deviceWidth = 1080;
let deviceHeight = 1920;

// 执行命令
function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

// 启动 Scrcpy 服务器
async function startScrcpyServer() {
  if (isRunning) return;
  isRunning = true;
  
  console.log('正在启动 Scrcpy 服务器...');
  
  try {
    // 先停止可能存在的 Scrcpy 实例
    await execAsync('pkill -f scrcpy || true');
    await new Promise(r => setTimeout(r, 1000));
    
    // 获取设备分辨率
    try {
      const { stdout } = await execAsync('adb shell wm size');
      const match = stdout.match(/(\d+)x(\d+)/);
      if (match) {
        deviceWidth = parseInt(match[1]);
        deviceHeight = parseInt(match[2]);
        console.log(`设备分辨率: ${deviceWidth}x${deviceHeight}`);
      }
    } catch (e) {
      console.log('使用默认分辨率 1080x1920');
    }
    
    // 启动 Scrcpy，使用 TCP 模式
    scrcpyProcess = spawn(SCRCPY_PATH, [
      '--tcpip=localhost:27183',
      '--no-control',
      '--no-display',
      '--max-fps=60',
      '--bit-rate=8M',
      '--max-size=1920',
      '--lock-video-orientation=0',
    ], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, ADB_SERVER_SOCKET_ADDRESS: 'tcp:localhost:5037' }
    });
    
    scrcpyProcess.stdout.on('data', (data) => {
      console.log(`[Scrcpy] ${data.toString()}`);
    });
    
    scrcpyProcess.stderr.on('data', (data) => {
      console.error(`[Scrcpy] ${data.toString()}`);
    });
    
    scrcpyProcess.on('close', (code) => {
      console.log(`Scrcpy 退出，代码: ${code}`);
      isRunning = false;
      // 5 秒后重新启动
      setTimeout(startScrcpyServer, 5000);
    });
    
    // 等待 3 秒让 Scrcpy 启动
    await new Promise(r => setTimeout(r, 3000));
    
  } catch (error) {
    console.error('Scrcpy 启动失败:', error);
    isRunning = false;
    // 5 秒后重试
    setTimeout(startScrcpyServer, 5000);
  }
}

// 创建 WebSocket 服务器
const wss = new WebSocket.WebSocketServer({ port: PORT });

wss.on('connection', (ws) => {
  console.log('新的 WebSocket 客户端连接');
  
  // 发送连接成功消息
  ws.send(JSON.stringify({
    type: 'connected',
    width: deviceWidth,
    height: deviceHeight
  }));
  
  // 连接到 Scrcpy TCP 流
  const client = new net.Socket();
  
  client.connect(27183, 'localhost', () => {
    console.log('已连接到 Scrcpy TCP 流');
  });
  
  client.on('data', (data) => {
    // 转发视频流数据
    if (ws.readyState === WebSocket.OPEN) {
      ws.send(data);
    }
  });
  
  client.on('close', () => {
    console.log('TCP 连接已关闭');
  });
  
  client.on('error', (error) => {
    console.error('TCP 连接错误:', error);
  });
  
  ws.on('message', (message) => {
    try {
      const msg = JSON.parse(message);
      if (msg.type === 'ping') {
        ws.send(JSON.stringify({ type: 'pong' }));
      }
    } catch (e) {
      console.log('收到消息:', message);
    }
  });
  
  ws.on('close', () => {
    console.log('WebSocket 客户端断开');
    client.destroy();
  });
  
  ws.on('error', (error) => {
    console.error('WebSocket 错误:', error);
    client.destroy();
  });
});

// 创建 HTTP 健康检查服务器
const httpServer = http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify({
    status: 'ok',
    isRunning: isRunning,
    device: {
      width: deviceWidth,
      height: deviceHeight
    }
  }));
});

httpServer.listen(PORT, () => {
  console.log(`Scrcpy WebSocket 服务器运行在 ws://localhost:${PORT}`);
  console.log(`健康检查: http://localhost:${PORT}`);
  // 启动 Scrcpy 服务器
  startScrcpyServer();
});

// 处理退出信号
process.on('SIGINT', () => {
  console.log('正在停止服务...');
  if (scrcpyProcess) {
    scrcpyProcess.kill();
  }
  process.exit(0);
});
