#!/usr/bin/env node
/**
 * 一键启动：先释放常用开发端口，再拉起所需子进程（由 npm scripts 定义）。
 * - 默认：ADB 桥接 3003 + Vite 3000 + scrcpy-server 13377/13378（视频流）
 * - --lite：仅桥接 + Vite（无 scrcpy）
 */
import { execSync, spawn } from 'child_process';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

/** 与 concurrently 子进程占用的端口一致 */
const DEV_PORTS = [3000, 3003, 13377, 13378];

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
      execSync('pkill -f "node adb-server.js" 2>/dev/null || true', {
        stdio: 'ignore',
        shell: '/bin/bash',
      });
      execSync('pkill -f "node scrcpy-server.js" 2>/dev/null || true', {
        stdio: 'ignore',
        shell: '/bin/bash',
      });
    } catch {
      /* 忽略 */
    }
  }
}

function main() {
  const lite = process.argv.includes('--lite');
  freeDevPorts();

  const script = lite ? 'dev:lite:run' : 'dev:run';
  console.log(`[start-all] 启动服务: npm run ${script}\n`);

  const child = spawn('npm', ['run', script], {
    cwd: root,
    stdio: 'inherit',
    env: process.env,
    shell: true,
  });

  child.on('exit', (code, signal) => {
    if (signal) process.exit(1);
    process.exit(code ?? 0);
  });
}

main();
