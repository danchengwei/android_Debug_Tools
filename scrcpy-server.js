#!/usr/bin/env node
/**
 * 自动拉起本机 Scrcpy 原生窗口（真·流畅），无需用户在终端手动执行 scrcpy。
 * 不在此进程内连接 27183，避免与 Scrcpy 抢占视频隧道导致黑屏/失败。
 *
 * HTTP **13377**：健康检查 + 供前端探测「原生 Scrcpy 是否已启动」（CORS 允许浏览器从 3000 访问）。
 *
 * 环境变量：
 * - SCRCPY_PATH：scrcpy 可执行文件路径
 * - SCRCPY_EXTRA_ARGS：额外参数，空格分隔，如 "--stay-awake --turn-screen-off"
 */
import { spawn, exec } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

const HTTP_PORT = 13377;

function resolveScrcpyPath() {
  const envPath = process.env.SCRCPY_PATH;
  if (envPath && fs.existsSync(envPath)) return envPath;
  const candidates = [
    '/opt/homebrew/bin/scrcpy',
    '/usr/local/bin/scrcpy',
    path.join(process.env.HOME || '', 'scrcpy/scrcpy'),
  ];
  for (const c of candidates) {
    if (c && fs.existsSync(c)) return c;
  }
  return 'scrcpy';
}

const SCRCPY_PATH = resolveScrcpyPath();
console.log('[scrcpy-server] 使用 scrcpy:', SCRCPY_PATH);

let scrcpyProcess = null;
let deviceWidth = 1080;
let deviceHeight = 1920;
/** 当前子进程是否在运行（退出后为 false，直至下次拉起成功） */
let nativeScrcpyRunning = false;
let restartTimer = null;

function execAsync(cmd) {
  return new Promise((resolve, reject) => {
    exec(cmd, { maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      resolve({ stdout, stderr });
    });
  });
}

function parseExtraArgs() {
  const raw = (process.env.SCRCPY_EXTRA_ARGS || '').trim();
  if (!raw) return [];
  return raw.split(/\s+/).filter(Boolean);
}

async function refreshDeviceSize() {
  try {
    const { stdout } = await execAsync('adb shell wm size');
    const match = stdout.match(/(\d+)x(\d+)/);
    if (match) {
      deviceWidth = parseInt(match[1], 10);
      deviceHeight = parseInt(match[2], 10);
      console.log(`[scrcpy-server] 设备分辨率: ${deviceWidth}x${deviceHeight}`);
    }
  } catch {
    console.log('[scrcpy-server] 使用默认分辨率 1080x1920');
  }
}

function killRestartTimer() {
  if (restartTimer) {
    clearTimeout(restartTimer);
    restartTimer = null;
  }
}

function scheduleRestartScrcpy() {
  killRestartTimer();
  restartTimer = setTimeout(() => {
    restartTimer = null;
    void launchNativeScrcpy();
  }, 5000);
}

/**
 * 启动原生 Scrcpy（子进程）。由 npm start 自动执行，用户无需手动开终端。
 */
async function launchNativeScrcpy() {
  if (scrcpyProcess && !scrcpyProcess.killed) {
    return;
  }

  console.log('[scrcpy-server] 正在自动启动本机 Scrcpy 窗口（流畅投屏）…');

  if (process.platform !== 'win32') {
    try {
      await execAsync('pkill -f scrcpy || true');
      await new Promise((r) => setTimeout(r, 800));
    } catch {
      /* 忽略 */
    }
  }

  await refreshDeviceSize();

  const baseArgs = [
    '--video-bit-rate=8M',
    '--max-size=1920',
    '--max-fps=60',
  ];
  const extra = parseExtraArgs();
  const args = [...baseArgs, ...extra];

  try {
    scrcpyProcess = spawn(SCRCPY_PATH, args, {
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env },
    });

    nativeScrcpyRunning = true;

    scrcpyProcess.stdout?.on('data', (data) => {
      const t = data.toString().trim();
      if (t) console.log('[scrcpy]', t);
    });

    scrcpyProcess.stderr?.on('data', (data) => {
      const t = data.toString();
      if (t.trim()) console.error('[scrcpy]', t);
    });

    scrcpyProcess.on('error', (err) => {
      console.error('[scrcpy-server] 无法启动 scrcpy:', err.message);
      nativeScrcpyRunning = false;
      scrcpyProcess = null;
      scheduleRestartScrcpy();
    });

    scrcpyProcess.on('close', (code) => {
      console.log(`[scrcpy-server] Scrcpy 进程已退出，代码: ${code}`);
      nativeScrcpyRunning = false;
      scrcpyProcess = null;
      scheduleRestartScrcpy();
    });

    console.log('[scrcpy-server] 已启动 Scrcpy，请在系统弹出的窗口中查看流畅画面。');
  } catch (e) {
    console.error('[scrcpy-server] 启动失败:', e);
    nativeScrcpyRunning = false;
    scrcpyProcess = null;
    scheduleRestartScrcpy();
  }
}

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Cache-Control': 'no-store',
  });
  res.end(body);
}

const httpServer = http.createServer((req, res) => {
  if (req.method === 'OPTIONS') {
    res.writeHead(204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
    });
    res.end();
    return;
  }

  if (req.method !== 'GET' || (req.url !== '/' && req.url !== '' && !req.url?.startsWith('/?'))) {
    sendJson(res, 404, { error: 'not_found' });
    return;
  }

  sendJson(res, 200, {
    status: 'ok',
    mode: 'native_window',
    /** 是否与 scrcpy 子进程仍保持运行（退出后约 5s 会重试拉起） */
    nativeScrcpyRunning,
    scrcpyPath: SCRCPY_PATH,
    device: {
      width: deviceWidth,
      height: deviceHeight,
    },
    hint: '流畅画面在本机 Scrcpy 系统窗口；网页内为 ADB 低帧预览。',
  });
});

httpServer.listen(HTTP_PORT, '0.0.0.0', () => {
  console.log(`[scrcpy-server] 控制/探测: http://127.0.0.1:${HTTP_PORT}/ （CORS 已开，供页面探测）`);
  void launchNativeScrcpy();
});

function shutdown() {
  killRestartTimer();
  console.log('[scrcpy-server] 正在退出…');
  if (scrcpyProcess && !scrcpyProcess.killed) {
    try {
      scrcpyProcess.kill('SIGTERM');
    } catch {
      /* 忽略 */
    }
  }
  httpServer.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
