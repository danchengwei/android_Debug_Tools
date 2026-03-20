import express from 'express';
import { exec, spawn } from 'child_process';
import fs from 'fs';
import path from 'path';

const app = express();

/** 解析 adb 可执行路径：环境变量 > 常见路径 > PATH 中的 adb */
function resolveAdbPath() {
  const envPath = process.env.ADB_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [
    '/opt/homebrew/bin/adb',
    '/usr/local/bin/adb',
    path.join(process.env.HOME || '', 'Library/Android/sdk/platform-tools/adb'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'adb';
}

const ADB_PATH = resolveAdbPath();
console.log('[adb-server] 使用 ADB:', ADB_PATH);

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

/** 前端连接前探测：桥接是否存活、当前解析到的 adb 路径 */
app.get('/api/health', (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.json({ ok: true, adbPath: ADB_PATH, port: 3003 });
});

app.get('/api/adb', (req, res) => {
  const command = req.query.command;
  if (!command || typeof command !== 'string') {
    return res.status(400).send('Missing command');
  }

  const fullCommand = command.replace(/^adb\s/, `${ADB_PATH} `);
  exec(fullCommand, { maxBuffer: 20 * 1024 * 1024, env: process.env }, (error, stdout, stderr) => {
    if (error) {
      const parts = [stderr?.trim(), stdout?.trim(), error.message].filter(Boolean);
      return res.status(500).send(parts.join('\n') || 'adb 执行失败');
    }
    res.send(stdout ?? '');
  });
});

/** 从 buffer 中定位 PNG 文件头（去掉 shell 可能带入的前缀） */
function sliceFromPngMagic(buf) {
  for (let i = 0; i <= Math.min(buf.length - 8, 512); i++) {
    if (buf[i] === 0x89 && buf[i + 1] === 0x50 && buf[i + 2] === 0x4e && buf[i + 3] === 0x47) {
      return buf.subarray(i);
    }
  }
  return buf;
}

function runScreencap(adb, args, res) {
  const screenshotProcess = spawn(adb, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let dataBuffer = Buffer.alloc(0);

  screenshotProcess.stdout.on('data', (data) => {
    dataBuffer = Buffer.concat([dataBuffer, data]);
  });

  let stderrText = '';
  screenshotProcess.stderr.on('data', (data) => {
    stderrText += data.toString();
  });

  screenshotProcess.on('close', (code) => {
    if (code !== 0 || dataBuffer.length < 64) {
      console.error('[adb-server] screencap 失败 code=', code, 'len=', dataBuffer.length, stderrText);
      return res.status(500).send(
        `截图失败（adb 退出码 ${code}）。请确认设备已连接且已授权 USB 调试。${stderrText ? ' ' + stderrText.slice(0, 200) : ''}`
      );
    }
    const png = sliceFromPngMagic(dataBuffer);
    if (png.length < 64 || png[0] !== 0x89) {
      return res.status(500).send('截图数据不是有效 PNG，请尝试升级 platform-tools 或使用 exec-out');
    }
    res.setHeader('Content-Type', 'image/png');
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.send(png);
  });

  screenshotProcess.on('error', (err) => {
    console.error('[adb-server] spawn 错误:', err);
    res.status(500).send('无法启动 adb：' + err.message);
  });
}

// 优先 exec-out，避免 adb shell 对二进制插入 \\r\\n 导致 PNG 损坏
// 可选 ?serial=xxx：多设备时与前端 localAdbService 选中的序列号一致
app.get('/api/screen', (req, res) => {
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  const args = serial
    ? ['-s', serial, 'exec-out', 'screencap', '-p']
    : ['exec-out', 'screencap', '-p'];
  runScreencap(ADB_PATH, args, res);
});

const server = app.listen(3003, '0.0.0.0', () => {
  console.log('ADB server running on http://127.0.0.1:3003 (listening 0.0.0.0:3003 for LAN)');
});

function cleanup() {
  console.log('正在清理 ADB 服务...');
  server.close(() => {
    console.log('HTTP 服务器已关闭');
    process.exit(0);
  });
}

process.on('SIGINT', cleanup);
process.on('SIGTERM', cleanup);
