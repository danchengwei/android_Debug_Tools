import express from 'express';
import { exec, spawn, execFile } from 'child_process';
import { promisify } from 'util';
import http from 'http';
import net from 'net';
import fs from 'fs';
import path from 'path';
import os from 'os';

const execAsync = promisify(exec);
const execFileAsync = promisify(execFile);

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

/** 设备序列号（含无线调试） */
function isSafeSerial(s) {
  return typeof s === 'string' && s.length >= 1 && s.length < 160 && /^[\w.:+-]+$/.test(s);
}

/** 包名：仅允许常见字符，防注入 */
function isSafePackageName(pkg) {
  return typeof pkg === 'string' && pkg.length >= 3 && pkg.length < 200 && /^[a-zA-Z][a-zA-Z0-9_.]+$/.test(pkg);
}

/** 仅允许项目目录下的相对 APK 路径，防路径穿越 */
function resolveSafeApkUnderCwd(rel) {
  if (typeof rel !== 'string' || rel.length < 6 || rel.length > 400) return null;
  if (rel.includes('..') || path.isAbsolute(rel)) return null;
  if (!/\.apk$/i.test(rel)) return null;
  const cwd = process.cwd();
  const resolved = path.resolve(cwd, rel);
  if (!resolved.startsWith(cwd)) return null;
  if (!fs.existsSync(resolved) || !fs.statSync(resolved).isFile()) return null;
  return resolved;
}

/** 仅允许 run-as 拉取的相对路径（databases / shared_prefs 下文件名） */
function isSafeRunAsRel(rel) {
  if (typeof rel !== 'string' || rel.length < 1 || rel.length > 240) return false;
  if (rel.includes('..') || rel.startsWith('/')) return false;
  return /^(databases\/[\w.-]+|shared_prefs\/[\w.-]+\.xml)$/.test(rel);
}

const jsonBodyParser = express.json({ limit: '4mb' });

function getFreeLocalPort() {
  return new Promise((resolve, reject) => {
    const s = net.createServer();
    s.listen(0, '127.0.0.1', () => {
      const addr = s.address();
      const p = typeof addr === 'object' && addr ? addr.port : 0;
      s.close((err) => (err ? reject(err) : resolve(p)));
    });
    s.on('error', reject);
  });
}

/**
 * 去掉 Chrome / WebView 常见的 XSSI 防护前缀，否则 JSON.parse 失败会表现为「人在 H5 页但列表始终为空」。
 */
function stripJsonPreamble(raw) {
  let t = String(raw).replace(/^\uFEFF/, '').trim();
  if (/^\)\]\}'/.test(t)) {
    t = t.replace(/^\)\]\}'\s*\n?/, '').trim();
  }
  if (/^while\s*\(\s*1\s*\)\s*;/.test(t)) {
    t = t.replace(/^while\s*\(\s*1\s*\)\s*;\s*\n?/, '').trim();
  }
  return t;
}

/**
 * 请求本机 adb forward 端口上的 DevTools 列表（显式 IPv4）。
 * @param {string} jsonPath 一般为 /json 或 /json/list（部分内核只认其一）
 */
function httpGetJsonFromLocalPort(port, timeoutMs, jsonPath = '/json') {
  return new Promise((resolve, reject) => {
    const req = http.get(
      {
        hostname: '127.0.0.1',
        port: Number(port),
        path: jsonPath,
        timeout: timeoutMs,
      },
      (res) => {
        let data = '';
        res.setEncoding('utf8');
        res.on('data', (c) => {
          data += c;
        });
        res.on('end', () => {
          if (res.statusCode !== 200) {
            reject(new Error(`HTTP ${res.statusCode}`));
            return;
          }
          const text = stripJsonPreamble(data);
          if (!text) {
            reject(new Error('empty body'));
            return;
          }
          try {
            resolve(JSON.parse(text));
          } catch (e) {
            reject(e);
          }
        });
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy();
      reject(new Error('timeout'));
    });
  });
}

async function adbForwardTcpAbstract(serial, localPort, abstractSuffix) {
  await execFileAsync(
    ADB_PATH,
    ['-s', serial, 'forward', `tcp:${localPort}`, `localabstract:${abstractSuffix}`],
    { timeout: 14000, windowsHide: true, maxBuffer: 65536 }
  );
}

async function adbForwardRemove(serial, localPort) {
  await execFileAsync(
    ADB_PATH,
    ['-s', serial, 'forward', '--remove', `tcp:${localPort}`],
    { timeout: 8000, windowsHide: true, maxBuffer: 65536 }
  );
}

/** 设备上出现的全部 DevTools 相关 PID（不区分应用）；含部分 ROM / Crosswalk / Trichrome 变体名 */
function extractAllDevtoolsPidsFromUnix(unixText) {
  const s = new Set();
  const patterns = [
    /webview_devtools_remote_(\d+)/g,
    /chrome_devtools_remote_(\d+)/g,
    /trichrome_devtools_remote_(\d+)/g,
    /xwalk_devtools_remote_(\d+)/g,
    /xwalk_debugger_remote_(\d+)/g,
  ];
  for (const re of patterns) {
    let m;
    while ((m = re.exec(unixText)) !== null) s.add(m[1]);
  }
  return [...s];
}

function scoreUrl(u) {
  if (!u || typeof u !== 'string') return 0;
  if (/^https:\/\//i.test(u)) return 4;
  if (/^http:\/\//i.test(u)) return 3;
  if (/^file:\/\//i.test(u)) return 2;
  if (/^about:/i.test(u)) return 0;
  return 1;
}

function coerceTargetUrl(entry) {
  if (!entry || typeof entry !== 'object') return null;
  let u = entry.url ?? entry.URL ?? entry.targetUrl;
  if (typeof u === 'string' && u.trim()) return u.trim();
  /** 部分 WebView 把真实地址写在 description 的 JSON 里，顶层 url 为空 */
  const desc = entry.description;
  if (typeof desc === 'string') {
    const t = desc.trim();
    if (t.startsWith('{')) {
      try {
        const d = JSON.parse(t);
        for (const k of ['url', 'visibleUrl', 'faviconUrl', 'targetUrl']) {
          const v = d[k];
          if (typeof v === 'string' && v.trim() && !/^about:/i.test(v)) return v.trim();
        }
      } catch {
        /* 忽略 */
      }
    }
    const m = t.match(/https?:\/\/[^\s"'\\]+/i);
    if (m) return m[0];
  }
  return null;
}

function coerceTargetTitle(entry) {
  if (!entry || typeof entry !== 'object') return null;
  const t = entry.title ?? entry.Title;
  return typeof t === 'string' ? t : null;
}

/** 将 /json 结果规范为数组（兼容旧版 WebView / 异常包装 / 部分内核用 pages 字段） */
function coerceJsonToTargetArray(json) {
  if (Array.isArray(json)) return json;
  if (json && typeof json === 'object' && Array.isArray(json.targetInfos)) return json.targetInfos;
  if (json && typeof json === 'object' && Array.isArray(json.targets)) return json.targets;
  if (json && typeof json === 'object' && Array.isArray(json.pages)) return json.pages;
  return [];
}

function normalizeDevtoolsTargets(json) {
  const arr = coerceJsonToTargetArray(json);
  const pages = [];
  for (const t of arr) {
    const u = coerceTargetUrl(t);
    if (!u || u.startsWith('chrome-extension://') || u.startsWith('devtools://')) continue;
    const type = (t.type || t.Type || '').toLowerCase();
    if (type === 'service_worker' || type === 'shared_worker' || type === 'background_page') continue;
    const httpish =
      /^https?:\/\//i.test(u) ||
      /^file:\/\//i.test(u) ||
      /^blob:/i.test(u) ||
      /^data:text\/html/i.test(u);
    /** http(s)/file/blob/data 一律保留；其余仅保留常见页面类 target（避免 worker 等噪音） */
    if (
      !httpish &&
      type &&
      type !== 'page' &&
      type !== 'webview' &&
      type !== 'iframe' &&
      type !== 'other' &&
      type !== 'app'
    ) {
      continue;
    }
    pages.push({
      url: u,
      title: coerceTargetTitle(t),
    });
  }
  const seen = new Set();
  const deduped = [];
  for (const p of pages) {
    if (seen.has(p.url)) continue;
    seen.add(p.url);
    deduped.push(p);
  }
  deduped.sort((a, b) => {
    const d = scoreUrl(b.url) - scoreUrl(a.url);
    if (d !== 0) return d;
    return (b.url || '').length - (a.url || '').length;
  });
  return deduped;
}

/**
 * 同一 PID 依次尝试 WebView 与 Chrome 两种 abstract 名（系统浏览器 / 部分壳用 chrome_ 前缀）
 */
async function tryDevtoolsJsonForPidBothKinds(serial, pid) {
  const kinds = [
    `webview_devtools_remote_${pid}`,
    `chrome_devtools_remote_${pid}`,
    `trichrome_devtools_remote_${pid}`,
    `xwalk_devtools_remote_${pid}`,
    `xwalk_debugger_remote_${pid}`,
  ];
  const merged = [];
  const seenUrl = new Set();
  for (const abstractName of kinds) {
    const localPort = await getFreeLocalPort();
    try {
      await adbForwardTcpAbstract(serial, localPort, abstractName);
    } catch {
      continue;
    }
    let json = null;
    for (const jsonPath of ['/json', '/json/list']) {
      try {
        json = await httpGetJsonFromLocalPort(localPort, 12000, jsonPath);
        if (json != null) break;
      } catch {
        /* 换路径重试 */
      }
    }
    try {
      await adbForwardRemove(serial, localPort);
    } catch {
      /* 忽略 */
    }
    for (const p of normalizeDevtoolsTargets(json)) {
      if (seenUrl.has(p.url)) continue;
      seenUrl.add(p.url);
      merged.push(p);
    }
  }
  return merged;
}

/** 按 PID 列表依次 forward + /json，合并去重（与 chrome://inspect 枚举方式一致，须扫完全部相关 PID，不能「见 http 就停」） */
async function collectPagesForPidList(serial, tryOrder, maxPids) {
  const merged = [];
  const seenUrl = new Set();
  for (const pid of tryOrder.slice(0, maxPids)) {
    const part = await tryDevtoolsJsonForPidBothKinds(serial, pid);
    for (const p of part) {
      if (seenUrl.has(p.url)) continue;
      seenUrl.add(p.url);
      merged.push(p);
    }
  }
  merged.sort((a, b) => {
    const d = scoreUrl(b.url) - scoreUrl(a.url);
    if (d !== 0) return d;
    return (b.url || '').length - (a.url || '').length;
  });
  return merged;
}

/**
 * 读取套接字列表：优先 exec-out（少经 shell 转义/截断，与 Chrome 侧枚举更一致），失败再回退 shell cat。
 */
async function readProcNetUnix(serial) {
  const attempts = [
    [ADB_PATH, '-s', serial, 'exec-out', 'cat', '/proc/net/unix'],
    [ADB_PATH, '-s', serial, 'shell', 'cat', '/proc/net/unix'],
  ];
  for (const args of attempts) {
    try {
      const { stdout } = await execFileAsync(args[0], args.slice(1), {
        maxBuffer: 5 * 1024 * 1024,
        timeout: 22000,
        windowsHide: true,
      });
      if (stdout && String(stdout).length > 30) return String(stdout);
    } catch {
      /* 下一种 */
    }
  }
  try {
    const { stdout } = await execAsync(`${ADB_PATH} -s ${serial} shell cat /proc/net/unix`, {
      maxBuffer: 5 * 1024 * 1024,
      timeout: 22000,
    });
    return stdout || '';
  } catch {
    return '';
  }
}

/**
 * 通过 adb forward + DevTools /json，与 chrome://inspect 同源：
 * 读 /proc/net/unix 里的 webview_devtools_remote_* / chrome_devtools_remote_*，对每个 PID 做 forward 后 GET /json 合并。
 *
 * 不再走「先按包名 pid 扫、见第一个 http 就停」：那会漏掉真正承载 H5 的进程（多进程 WebView 很常见），Inspect 则是全设备枚举。
 */
async function listWebViewPagesViaDevtools(serial, pkg) {
  const unixText = await readProcNetUnix(serial);
  const globalPids = extractAllDevtoolsPidsFromUnix(unixText);

  if (globalPids.length === 0) {
    return {
      ok: false,
      reason: 'no_devtools_on_device',
      pages: [],
      socketCount: 0,
      hint: '设备上无 webview/chrome_devtools 套接字，多为未开启 WebView 调试或内核非 Chromium',
    };
  }

  const globalOrder = [...globalPids].sort((a, b) => parseInt(b, 10) - parseInt(a, 10));
  const mergedGlobal = await collectPagesForPidList(serial, globalOrder, 128);

  if (mergedGlobal.length > 0) {
    console.log(
      `[adb-server] webview-pages ok (inspect_same_as_chrome) count=${mergedGlobal.length} socketPids=${globalPids.length}` +
        (pkg ? ` hintPkg=${pkg}` : '')
    );
    return {
      ok: true,
      reason: 'devtools_inspect',
      matchedPackage: pkg && isSafePackageName(pkg) ? pkg : null,
      pages: mergedGlobal,
      socketCount: globalPids.length,
    };
  }

  console.warn('[adb-server] webview-pages fail: sockets exist but /json empty (调试未开或内核不支持)');
  return {
    ok: false,
    reason: 'devtools_socket_no_json',
    pages: [],
    socketCount: globalPids.length,
    hint: '有套接字但拉不到页面列表：请确认应用已调用 WebView.setWebContentsDebuggingEnabled(true) 或使用 debuggable 包；Chrome 网页请用系统 Chrome 包名测试',
  };
}

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

/**
 * WebView 真实 URL：走 DevTools /json（与 chrome://inspect 一致）。
 * 查询参数：serial、package（前台应用包名）
 */
app.get('/api/webview-pages', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  const pkg = typeof req.query.package === 'string' ? req.query.package.trim() : '';
  if (!isSafeSerial(serial)) {
    return res.status(400).json({ ok: false, reason: 'bad_param', pages: [] });
  }
  if (pkg && !isSafePackageName(pkg)) {
    return res.status(400).json({ ok: false, reason: 'bad_param', pages: [] });
  }
  try {
    const out = await listWebViewPagesViaDevtools(serial, pkg || null);
    res.json(out);
  } catch (e) {
    console.error('[adb-server] webview-pages:', e?.message || e);
    res.json({ ok: false, reason: 'error', pages: [] });
  }
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

/**
 * 上传 APK 覆盖安装（-r -t -d）。正文为原始字节；query 必含 serial。
 */
app.post(
  '/api/install-apk',
  express.raw({ limit: '512mb', type: () => true }),
  async (req, res) => {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
    if (!isSafeSerial(serial)) {
      return res.status(400).json({ ok: false, message: '缺少或非法 serial' });
    }
    const body = req.body;
    if (!Buffer.isBuffer(body) || body.length < 100) {
      return res.status(400).json({ ok: false, message: 'APK 正文过小或为空' });
    }
    if (body[0] !== 0x50 || body[1] !== 0x4b) {
      return res.status(400).json({ ok: false, message: '不是有效的 APK（应为 ZIP 文件头）' });
    }
    const tmp = path.join(os.tmpdir(), `droidscope-${Date.now()}-${Math.random().toString(16).slice(2)}.apk`);
    try {
      fs.writeFileSync(tmp, body);
      const { stdout, stderr } = await execFileAsync(
        ADB_PATH,
        ['-s', serial, 'install', '-r', '-t', '-d', tmp],
        { maxBuffer: 2 * 1024 * 1024, timeout: 600000, windowsHide: true }
      );
      const out = `${stdout || ''}\n${stderr || ''}`.trim();
      const success = /\bSuccess\b/i.test(out) && !/\bFailure\b|\bINSTALL_FAILED/i.test(out);
      res.json({ ok: success, output: out || '(无输出)' });
    } catch (e) {
      const msg = [e?.stderr, e?.stdout, e?.message].filter(Boolean).join('\n');
      res.status(500).json({ ok: false, output: String(msg || e) });
    } finally {
      try {
        fs.unlinkSync(tmp);
      } catch {
        /* 忽略 */
      }
    }
  }
);

/** 从桥接进程当前工作目录（一般为项目根）安装相对路径 APK，便于 Gradle 输出 */
app.post('/api/install-apk-from-path', jsonBodyParser, async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.body?.serial === 'string' ? req.body.serial.trim() : '';
  const rel = typeof req.body?.relativePath === 'string' ? req.body.relativePath.trim() : '';
  if (!isSafeSerial(serial)) {
    return res.status(400).json({ ok: false, message: '非法 serial' });
  }
  const abs = resolveSafeApkUnderCwd(rel);
  if (!abs) {
    return res.status(400).json({ ok: false, message: '路径非法、非 APK 或文件不存在（须为项目目录下相对路径）' });
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'install', '-r', '-t', '-d', abs],
      { maxBuffer: 2 * 1024 * 1024, timeout: 600000, windowsHide: true }
    );
    const out = `${stdout || ''}\n${stderr || ''}`.trim();
    const success = /\bSuccess\b/i.test(out) && !/\bFailure\b|\bINSTALL_FAILED/i.test(out);
    res.json({ ok: success, output: out || '(无输出)', path: abs });
  } catch (e) {
    const msg = [e?.stderr, e?.stdout, e?.message].filter(Boolean).join('\n');
    res.status(500).json({ ok: false, output: String(msg || e) });
  }
});

/** 清应用缓存（不清数据）；需系统支持 cmd package clear-cache（约 API 23+） */
app.post('/api/clear-app-cache', jsonBodyParser, async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.body?.serial === 'string' ? req.body.serial.trim() : '';
  const pkg = typeof req.body?.package === 'string' ? req.body.package.trim() : '';
  if (!isSafeSerial(serial) || !isSafePackageName(pkg)) {
    return res.status(400).json({ ok: false, message: '参数非法' });
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'shell', 'cmd', 'package', 'clear-cache', pkg],
      { maxBuffer: 65536, timeout: 60000, windowsHide: true }
    );
    const out = `${stdout || ''}\n${stderr || ''}`.trim();
    res.json({ ok: true, output: out || 'OK' });
  } catch (e) {
    res.json({ ok: false, output: String(e?.message || e) });
  }
});

/** 拉取与崩溃相关的轻量信息（部分路径需设备权限，失败时对应段落为错误说明） */
app.post('/api/debug-artifacts', jsonBodyParser, async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.body?.serial === 'string' ? req.body.serial.trim() : '';
  if (!isSafeSerial(serial)) {
    return res.status(400).json({ ok: false, message: '非法 serial' });
  }
  const parts = {};
  const run = async (key, shellScript) => {
    try {
      const { stdout, stderr } = await execFileAsync(
        ADB_PATH,
        ['-s', serial, 'shell', 'sh', '-c', shellScript],
        { maxBuffer: 3 * 1024 * 1024, timeout: 50000, windowsHide: true }
      );
      parts[key] = String(stdout || stderr || '').slice(0, 480000);
    } catch (e) {
      parts[key] = `（获取失败）${e?.message || e}`;
    }
  };
  await run('anr_dir', 'ls -la /data/anr 2>&1 | tail -n 80');
  await run('tombstones_dir', 'ls -la /data/tombstones 2>&1 | tail -n 50');
  await run(
    'tombstone_sample',
    'f=$(ls -t /data/tombstones/tombstone_* 2>/dev/null | head -1); [ -n "$f" ] && head -c 180000 "$f" || echo "(无 tombstone 文件或无权限)"'
  );
  await run('logcat_crash', 'logcat -d -b crash -t 80 2>&1');
  await run('dropbox_tail', 'dumpsys dropbox 2>&1 | tail -c 100000');
  res.json({ ok: true, parts });
});

/** 读取全局 HTTP 代理（settings global http_proxy） */
app.get('/api/http-proxy', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  if (!isSafeSerial(serial)) {
    return res.status(400).json({ ok: false, message: '非法 serial' });
  }
  try {
    const { stdout } = await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'shell', 'settings', 'get', 'global', 'http_proxy'],
      { maxBuffer: 4096, timeout: 15000, windowsHide: true }
    );
    res.json({ ok: true, proxy: (stdout || '').trim() });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

/** 设置或清除全局 HTTP 代理；body.proxy 为空字符串则清除（:0） */
app.post('/api/http-proxy', jsonBodyParser, async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.body?.serial === 'string' ? req.body.serial.trim() : '';
  const proxyVal = req.body?.proxy;
  if (!isSafeSerial(serial)) {
    return res.status(400).json({ ok: false, message: '非法 serial' });
  }
  try {
    if (proxyVal == null || String(proxyVal).trim() === '') {
      await execFileAsync(
        ADB_PATH,
        ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', ':0'],
        { maxBuffer: 4096, timeout: 15000, windowsHide: true }
      );
      return res.json({ ok: true, message: '已清除代理' });
    }
    const p = String(proxyVal).trim();
    if (!/^[\w.-]+:\d{1,5}$/.test(p)) {
      return res.status(400).json({ ok: false, message: '格式应为 host:port，例如 192.168.1.2:8888' });
    }
    await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'shell', 'settings', 'put', 'global', 'http_proxy', p],
      { maxBuffer: 4096, timeout: 15000, windowsHide: true }
    );
    res.json({ ok: true, message: `已设为 ${p}` });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

/** 当前包权限相关行摘要（dumpsys package 过滤，避免整包 JSON 过大） */
app.get('/api/package-permissions', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  const pkg = typeof req.query.package === 'string' ? req.query.package.trim() : '';
  if (!isSafeSerial(serial) || !isSafePackageName(pkg)) {
    return res.status(400).json({ ok: false, message: '参数非法' });
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'shell', 'dumpsys', 'package', pkg],
      { maxBuffer: 14 * 1024 * 1024, timeout: 90000, windowsHide: true }
    );
    const text = String(stdout || stderr || '');
    const lines = text
      .split(/\r?\n/)
      .filter((l) =>
        /granted|android\.permission|runtime permission|install permission|Permission [gs]/i.test(l)
      );
    const max = 500;
    res.json({
      ok: true,
      summary: lines.slice(0, max).join('\n'),
      truncated: lines.length > max,
      lineCount: lines.length,
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

/** debuggable 应用下列出 databases 或 shared_prefs（run-as ls） */
app.get('/api/run-as-list', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  const pkg = typeof req.query.package === 'string' ? req.query.package.trim() : '';
  const kind = req.query.kind === 'shared_prefs' ? 'shared_prefs' : 'databases';
  if (!isSafeSerial(serial) || !isSafePackageName(pkg)) {
    return res.status(400).json({ ok: false, message: '参数非法' });
  }
  try {
    const { stdout, stderr } = await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'shell', 'run-as', pkg, 'ls', '-la', kind],
      { maxBuffer: 512 * 1024, timeout: 30000, windowsHide: true }
    );
    res.json({ ok: true, output: String(stdout || stderr || '').slice(0, 400000) });
  } catch (e) {
    res.json({ ok: false, output: String(e?.message || e) });
  }
});

/** 通过 run-as 读取单个文件（仅允许 databases/* 与 shared_prefs/*.xml） */
app.get('/api/run-as-file', async (req, res) => {
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  const pkg = typeof req.query.package === 'string' ? req.query.package.trim() : '';
  const rel = typeof req.query.relPath === 'string' ? req.query.relPath.trim() : '';
  if (!isSafeSerial(serial) || !isSafePackageName(pkg) || !isSafeRunAsRel(rel)) {
    return res.status(400).json({ ok: false, message: '参数非法' });
  }
  try {
    const { stdout } = await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'exec-out', 'run-as', pkg, 'cat', rel],
      { encoding: 'buffer', maxBuffer: 5 * 1024 * 1024, timeout: 60000, windowsHide: true }
    );
    const buf = Buffer.isBuffer(stdout) ? stdout : Buffer.from(String(stdout), 'utf8');
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${path.basename(rel)}"`);
    res.send(buf);
  } catch (e) {
    res.status(500).type('json').json({ ok: false, message: String(e?.message || e) });
  }
});

/** Monkey 压测（包名必传，事件数与节流有上限） */
app.post('/api/monkey', jsonBodyParser, async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.body?.serial === 'string' ? req.body.serial.trim() : '';
  const pkg = typeof req.body?.package === 'string' ? req.body.package.trim() : '';
  if (!isSafeSerial(serial) || !isSafePackageName(pkg)) {
    return res.status(400).json({ ok: false, message: '参数非法' });
  }
  let events = parseInt(String(req.body?.events ?? '500'), 10);
  if (Number.isNaN(events)) events = 500;
  events = Math.min(50000, Math.max(1, events));
  let throttle = parseInt(String(req.body?.throttle ?? '200'), 10);
  if (Number.isNaN(throttle)) throttle = 200;
  throttle = Math.min(5000, Math.max(0, throttle));
  /** HTTP 不宜无限等待：最长约 10 分钟，超大事件数会在中途被系统终止 Monkey 进程 */
  const timeoutMs = Math.min(600000, Math.max(90000, events * Math.max(throttle, 50) + 60000));
  try {
    const { stdout, stderr } = await execFileAsync(
      ADB_PATH,
      ['-s', serial, 'shell', 'monkey', '-p', pkg, '--throttle', String(throttle), '-v', String(events)],
      { maxBuffer: 512 * 1024, timeout: timeoutMs, windowsHide: true }
    );
    const out = `${stdout || ''}\n${stderr || ''}`.trim();
    res.json({ ok: true, output: out.slice(0, 200000) });
  } catch (e) {
    const out = [e?.stdout, e?.stderr, e?.message].filter(Boolean).join('\n');
    res.json({ ok: false, output: String(out || e).slice(0, 200000) });
  }
});

/** WebView DevTools 套接字与页面数量摘要（与 webview-pages 同源逻辑） */
app.get('/api/webview-summary', async (req, res) => {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  const serial = typeof req.query.serial === 'string' ? req.query.serial.trim() : '';
  const pkgRaw = typeof req.query.package === 'string' ? req.query.package.trim() : '';
  if (!isSafeSerial(serial)) {
    return res.status(400).json({ ok: false, message: '非法 serial' });
  }
  const pkg = isSafePackageName(pkgRaw) ? pkgRaw : '';
  try {
    const out = await listWebViewPagesViaDevtools(serial, pkg || null);
    res.json({
      ok: out.ok !== false,
      socketCount: out.socketCount ?? 0,
      pageCount: Array.isArray(out.pages) ? out.pages.length : 0,
      hint: out.hint || out.reason || '',
    });
  } catch (e) {
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
});

/** 网页无法可靠打开 chrome://，由本机在用户电脑上拉起 Chrome（与双击书签效果类似） */
const CHROME_INSPECT_URL = 'chrome://inspect/#devices';

function handleOpenDesktopInspect(_req, res) {
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  try {
    const plat = process.platform;
    if (plat === 'darwin') {
      const c = spawn('open', ['-a', 'Google Chrome', CHROME_INSPECT_URL], {
        detached: true,
        stdio: 'ignore',
      });
      c.unref();
    } else if (plat === 'win32') {
      const c = spawn('cmd', ['/c', 'start', 'chrome', CHROME_INSPECT_URL], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      c.unref();
    } else {
      const sh = `command -v google-chrome >/dev/null 2>&1 && exec google-chrome "${CHROME_INSPECT_URL}"; command -v google-chrome-stable >/dev/null 2>&1 && exec google-chrome-stable "${CHROME_INSPECT_URL}"; command -v chromium >/dev/null 2>&1 && exec chromium "${CHROME_INSPECT_URL}"; command -v chromium-browser >/dev/null 2>&1 && exec chromium-browser "${CHROME_INSPECT_URL}"; exec xdg-open "${CHROME_INSPECT_URL}"`;
      const c = spawn('sh', ['-c', sh], { detached: true, stdio: 'ignore' });
      c.unref();
    }
    console.log('[adb-server] 已请求打开 Chrome 远程调试页:', CHROME_INSPECT_URL);
    res.json({ ok: true });
  } catch (e) {
    console.error('[adb-server] open-desktop-inspect:', e?.message || e);
    res.status(500).json({ ok: false, message: String(e?.message || e) });
  }
}

app.post('/api/open-desktop-inspect', handleOpenDesktopInspect);
app.get('/api/open-desktop-inspect', handleOpenDesktopInspect);

/** 未匹配的 /api 路径返回 JSON，避免前端把 HTML 404 当成「桥接坏了」难排查 */
app.use((req, res) => {
  if (req.path.startsWith('/api')) {
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    return res.status(404).json({
      ok: false,
      reason: 'not_found',
      path: req.path,
      message: '桥接无此接口，请确认 adb-server 为本仓库当前版本',
    });
  }
  res.status(404).type('text').send('Not found');
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
