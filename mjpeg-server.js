import express from 'express';
import { spawn } from 'child_process';
const app = express();

const ADB_PATH = '/opt/homebrew/bin/adb';
const PORT = 3005;

// CORS
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// MJPEG 流端点
app.get('/stream.mjpeg', (req, res) => {
  res.writeHead(200, {
    'Content-Type': 'multipart/x-mixed-replace; boundary=--myboundary',
    'Cache-Control': 'no-cache',
    'Connection': 'keep-alive'
  });

  let running = true;
  let captureProcess = null;

  const captureFrame = () => {
    if (!running) return;

    // 使用 adb 截图
    captureProcess = spawn(ADB_PATH, ['shell', 'screencap', '-p']);
    let buffer = Buffer.alloc(0);

    captureProcess.stdout.on('data', (data) => {
      buffer = Buffer.concat([buffer, data]);
    });

    captureProcess.on('close', (code) => {
      if (code === 0 && running) {
        // 发送 MJPEG 帧
        res.write('--myboundary\r\n');
        res.write('Content-Type: image/png\r\n');
        res.write(`Content-Length: ${buffer.length}\r\n\r\n`);
        res.write(buffer);
        res.write('\r\n');
      }
      // 30 FPS = 33ms 间隔
      setTimeout(captureFrame, 33);
    });

    captureProcess.stderr.on('data', (data) => {
      console.error('截图错误:', data.toString());
    });
  };

  captureFrame();

  req.on('close', () => {
    running = false;
    if (captureProcess) captureProcess.kill();
    console.log('客户端断开连接');
  });
});

// 单张截图 API（备用）
app.get('/api/screen', (req, res) => {
  const screenshotProcess = spawn(ADB_PATH, ['shell', 'screencap', '-p']);
  let buffer = Buffer.alloc(0);

  screenshotProcess.stdout.on('data', (data) => {
    buffer = Buffer.concat([buffer, data]);
  });

  screenshotProcess.on('close', (code) => {
    if (code !== 0) {
      return res.status(500).send('截图失败');
    }
    res.setHeader('Content-Type', 'image/png');
    res.send(buffer);
  });
});

const server = app.listen(PORT, () => {
  console.log(`MJPEG 服务器运行在 http://localhost:${PORT}`);
  console.log(`流地址: http://localhost:${PORT}/stream.mjpeg`);
});

function cleanup() {
  console.log('正在清理 MJPEG 服务器...');
  server.close(() => process.exit(0));
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
