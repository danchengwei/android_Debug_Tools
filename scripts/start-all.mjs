#!/usr/bin/env node
/**
 * 一键启动：先释放常用开发端口、结束旧 adb/scrcpy 进程，再拉起所需子进程；启动后自检桥接（含 H5 /api/webview-pages）。
 * - 默认：ADB 桥接 3003 + Vite 3000 + scrcpy-server 13377（自动本机 Scrcpy 窗口 + HTTP 探测）
 * - --lite：仅桥接 + Vite（无 scrcpy）
 * - 环境变量 ANDROID_DEBUG_TOOLS_OPEN_BROWSER=1：由「启动调试工具」脚本设置，界面就绪后自动打开系统默认浏览器（用户无需记网址）。
 */
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** 与 concurrently 子进程占用的端口一致 */
const DEV_PORTS = [3000, 3003, 13377];

/**
 * Windows：根据 netstat 释放监听指定端口的进程（尽力而为，不保证覆盖所有情况）。
 */
function freePortWindows(port) {
  try {
    const out = execSync('netstat -ano', { encoding: 'utf8' });
    const pids = new Set();
    for (const line of out.split('\n')) {
      const t = line.trim();
      if (!t.includes('LISTENING')) continue;
      // 匹配 :3000 或 0.0.0.0:3000 等形式
      if (!new RegExp(`:${port}(?:\\s|$)`).test(t)) continue;
      const parts = t.split(/\s+/);
      const pid = parts[parts.length - 1];
      if (/^\d+$/.test(pid)) pids.add(pid);
    }
    for (const pid of pids) {
      try {
        execSync(`taskkill /F /PID ${pid}`, { stdio: 'ignore' });
      } catch {
        /* 忽略无权限或进程已退出 */
      }
    }
  } catch {
    /* netstat 不可用等 */
  }
}

/**
 * macOS / Linux：lsof 释放端口
 */
function freePortUnix(port) {
  try {
    execSync(`lsof -ti :${port} | xargs kill -9 2>/dev/null`, {
      stdio: 'ignore',
      shell: '/bin/bash',
    });
  } catch {
    /* 无占用 */
  }
}

function freeDevPorts() {
  const isWin = process.platform === 'win32';
  console.log('[start-all] 尝试释放端口:', DEV_PORTS.join(', '));
  for (const p of DEV_PORTS) {
    if (isWin) freePortWindows(p);
    else freePortUnix(p);
  }
  if (!isWin) {
    try {
      for (const pattern of [
        'node adb-server.js',
        'adb-server.js',
        'node scrcpy-server.js',
        'scrcpy-server.js',
      ]) {
        execSync(`pkill -f "${pattern}" 2>/dev/null || true`, {
          stdio: 'ignore',
          shell: '/bin/bash',
        });
      }
    } catch {
      /* 忽略 */
    }
  }
}

function sleepSyncMs(ms) {
  try {
    if (process.platform === 'win32') {
      execSync(`powershell -Command "Start-Sleep -Milliseconds ${ms}"`, { stdio: 'ignore' });
    } else {
      execSync(`sleep ${(ms / 1000).toFixed(2)}`, { stdio: 'ignore' });
    }
  } catch {
    /* 无 sleep 则跳过 */
  }
}

/**
 * 探测 3003 桥接：无 query 的 webview-pages 应返回 400 JSON；404 多为端口上不是本仓库 adb-server。
 * @returns {{ ok: true } | { ok: false, reason: 'timeout' | 'webview_404' }}
 */
async function probeBridgeHealth() {
  const maxAttempts = 100;
  const intervalMs = 250;
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    try {
      const health = await fetch('http://127.0.0.1:3003/api/health', { cache: 'no-store' });
      if (!health.ok) continue;

      const wv = await fetch('http://127.0.0.1:3003/api/webview-pages', { cache: 'no-store' });
      const ct = (wv.headers.get('content-type') || '').toLowerCase();
      if (wv.status === 404) {
        return { ok: false, reason: 'webview_404' };
      }
      if (wv.status === 400 && ct.includes('json')) {
        return { ok: true };
      }
      if (wv.ok) {
        return { ok: true };
      }
      if (wv.status !== 404) {
        return { ok: true };
      }
    } catch {
      /* 尚未监听 */
    }
  }
  return { ok: false, reason: 'timeout' };
}

function logBridgeProbeResult(result) {
  if (result.ok) {
    console.log('[start-all] ✓ 桥接自检通过：/api/health 与 /api/webview-pages（H5 调试）可用');
    return;
  }
  if (result.reason === 'webview_404') {
    console.error(
      '[start-all] ⚠ 桥接在 3003 已响应，但 /api/webview-pages 为 404（多为旧版或其它项目占端口）。将尝试自动重启一轮。'
    );
    return;
  }
  console.warn(
    '[start-all] ⚠ 未在约 25s 内检测到 3003 桥接，将尝试自动释放端口并重新启动一轮。'
  );
}

/**
 * 结束 npm 拉起的 concurrently 子树（Windows 用 taskkill /T，Unix 用 SIGTERM）。
 */
function killNpmStackChild(child) {
  if (!child?.pid) return;
  try {
    if (process.platform === 'win32') {
      execSync(`taskkill /PID ${child.pid} /T /F`, { stdio: 'ignore' });
    } else {
      child.kill('SIGTERM');
    }
  } catch {
    try {
      child.kill('SIGKILL');
    } catch {
      /* 忽略 */
    }
  }
}

/** 由图形化启动脚本触发，整个进程内只打开一次，避免重复弹窗 */
let defaultBrowserOpened = false;

/**
 * 在系统默认浏览器中打开本地调试页（不依赖用户记忆地址）。
 */
function openDefaultBrowserIfEnabled(url) {
  if (process.env.ANDROID_DEBUG_TOOLS_OPEN_BROWSER !== '1') return;
  if (defaultBrowserOpened) return;
  defaultBrowserOpened = true;
  const plat = process.platform;
  try {
    if (plat === 'darwin') {
      const c = spawn('open', [url], { detached: true, stdio: 'ignore' });
      c.unref();
    } else if (plat === 'win32') {
      const c = spawn('cmd', ['/c', 'start', '', url], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      c.unref();
    } else {
      const c = spawn('xdg-open', [url], { detached: true, stdio: 'ignore' });
      c.unref();
    }
    console.log('[start-all] 已在默认浏览器中打开调试界面（若被拦截请允许弹窗）');
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    console.warn('[start-all] 自动打开浏览器失败，请手动打开浏览器访问本工具页面或重新双击启动脚本。详情:', msg);
  }
}

/**
 * 等待 Vite 页面可访问后自动打开浏览器（仅 ANDROID_DEBUG_TOOLS_OPEN_BROWSER=1 时）。
 */
async function waitForViteAndOpenBrowser() {
  if (process.env.ANDROID_DEBUG_TOOLS_OPEN_BROWSER !== '1') return;
  const maxAttempts = 120;
  const intervalMs = 500;
  const pageUrl = 'http://127.0.0.1:3000/';
  for (let i = 0; i < maxAttempts; i++) {
    await new Promise((r) => setTimeout(r, intervalMs));
    const ctrl = new AbortController();
    const t = setTimeout(() => ctrl.abort(), 3000);
    try {
      const r = await fetch(pageUrl, {
        method: 'GET',
        headers: { Accept: 'text/html,*/*' },
        cache: 'no-store',
        signal: ctrl.signal,
      });
      if (r.ok) {
        openDefaultBrowserIfEnabled(pageUrl);
        return;
      }
    } catch {
      /* 开发服务器尚未就绪 */
    } finally {
      clearTimeout(t);
    }
  }
  console.warn('[start-all] 等待界面服务超时，若窗口仍在跑请稍后刷新浏览器或重新双击启动脚本');
}

function main() {
  const lite = process.argv.includes('--lite');
  const guiMode = process.env.ANDROID_DEBUG_TOOLS_OPEN_BROWSER === '1';

  freeDevPorts();
  sleepSyncMs(400);
  freeDevPorts();

  const script = lite ? 'dev:lite:run' : 'dev:run';
  if (guiMode) {
    console.log('[start-all] 图形化启动：就绪后将自动打开浏览器，请保持本窗口打开。\n');
  }
  console.log(`[start-all] 启动服务: npm run ${script}\n`);

  /** 递增后，旧子进程的 exit 回调不再触发 process.exit（避免自动重启时误退出 start-all） */
  let activeExitGen = 0;

  function spawnStack() {
    return spawn('npm', ['run', script], {
      cwd: root,
      stdio: 'inherit',
      env: process.env,
      shell: true,
    });
  }

  function attachExitHandler(c) {
    const gen = ++activeExitGen;
    c.on('exit', (code, signal) => {
      if (gen !== activeExitGen) return;
      if (signal) process.exit(1);
      process.exit(code ?? 0);
    });
  }

  let child = spawnStack();
  attachExitHandler(child);

  void waitForViteAndOpenBrowser();

  void (async () => {
    let result = await probeBridgeHealth();
    logBridgeProbeResult(result);

    const needRetry = !result.ok && (result.reason === 'timeout' || result.reason === 'webview_404');
    if (needRetry) {
      console.warn('[start-all] —— 自动重启：正在结束当前进程树并释放端口，约 2 秒后重新拉起 ——\n');
      activeExitGen += 1;
      killNpmStackChild(child);
      await new Promise((r) => setTimeout(r, 2000));
      freeDevPorts();
      sleepSyncMs(400);
      freeDevPorts();

      child = spawnStack();
      attachExitHandler(child);

      result = await probeBridgeHealth();
      logBridgeProbeResult(result);
      if (!result.ok) {
        console.error(
          '[start-all] ✗ 自动重启后桥接仍未就绪，请查看上方 [bridge]/[vite] 日志；仍异常时可再双击启动脚本。'
        );
      }
    }
  })();
}

main();
