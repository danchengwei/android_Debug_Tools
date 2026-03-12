import express from 'express';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
const app = express();

// ADB 命令路径
const ADB_PATH = '/opt/homebrew/bin/adb';

// 添加 CORS 支持
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS, PUT, PATCH, DELETE');
  res.setHeader('Access-Control-Allow-Headers', 'X-Requested-With,content-type');
  res.setHeader('Access-Control-Allow-Credentials', 'true');
  if (req.method === 'OPTIONS') {
    return res.status(200).end();
  }
  next();
});

app.get('/api/adb', (req, res) => {
  const command = req.query.command;
  if (!command) {
    return res.status(400).send('Missing command');
  }

  // 替换命令中的 adb 为绝对路径
  const fullCommand = command.replace(/^adb\s/, `${ADB_PATH} `);
  exec(fullCommand, (error, stdout, stderr) => {
    if (error) {
      return res.status(500).send(error.message);
    }
    res.send(stdout);
  });
});

// 优化的截图 API - 使用流式传输
app.get('/api/screen', (req, res) => {
  // 使用 spawn 而不是 exec，避免缓冲区问题
  const screenshotProcess = spawn(ADB_PATH, ['shell', 'screencap', '-p']);
  
  let dataBuffer = Buffer.alloc(0);
  
  screenshotProcess.stdout.on('data', (data) => {
    dataBuffer = Buffer.concat([dataBuffer, data]);
  });
  
  screenshotProcess.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).send('截图失败');
    }
    
    // 直接发送二进制数据，前端使用 Blob URL
    res.setHeader('Content-Type', 'image/png');
    res.send(dataBuffer);
  });
  
  screenshotProcess.stderr.on('data', (data) => {
    console.error('截图错误:', data.toString());
  });
});

// 启动服务器
const server = app.listen(3003, () => {
  console.log('ADB server running on http://localhost:3003');
});

// 处理进程终止信号
function cleanup() {
  console.log('正在清理 ADB 服务...');
  
  // 关闭服务器
  server.close(() => {
    console.log('HTTP 服务器已关闭');
    
    // 停止 ADB 守护进程
    exec(`${ADB_PATH} kill-server`, (error, stdout, stderr) => {
      if (error) {
        console.error('关闭 ADB 守护进程失败:', error.message);
      } else {
        console.log('ADB 守护进程已关闭');
      }
      process.exit(0);
    });
  });
}

// 监听进程终止信号
process.on('SIGINT', cleanup);  // Ctrl+C
process.on('SIGTERM', cleanup); // 终止信号
