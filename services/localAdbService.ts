import { DeviceInfo, AppStackInfo, AppEnvInfo, H5Info, LayoutNode, LogEntry, LogLevel } from '../types';

/**
 * 使用本地 ADB 替代 WebUSB（经本机 adb-server HTTP 桥接）
 */
export class LocalAdbService {
  private connected: boolean = false;
  /** 当前选中的 ADB 设备序列号；所有 adb shell 与截图会带 `-s` */
  private deviceSerial: string | null = null;

  /**
   * 解析 `adb devices` 文本输出（与命令行列格式一致）。
   */
  private parseAdbDevices(output: string): {
    authorized: string[];
    unauthorized: string[];
    offline: string[];
  } {
    const authorized: string[] = [];
    const unauthorized: string[] = [];
    const offline: string[] = [];
    const lines = output.split(/\r?\n/);
    for (const line of lines) {
      const t = line.trim();
      if (!t || t === 'List of devices attached') continue;
      const m = t.match(/^(\S+)\s+(device|unauthorized|offline|recovery|sideload)\s*$/);
      if (!m) continue;
      const serial = m[1];
      const state = m[2];
      if (state === 'device') authorized.push(serial);
      else if (state === 'unauthorized') unauthorized.push(serial);
      else if (state === 'offline') offline.push(serial);
    }
    return { authorized, unauthorized, offline };
  }

  /** 为命令中每一处 `adb ` 注入 `-s 序列号`（多设备时必须） */
  private formatAdbCommand(command: string): string {
    if (!this.deviceSerial) return command;
    return command.replace(/\badb\s+/g, `adb -s ${this.deviceSerial} `);
  }

  /**
   * 桥接地址与当前页面主机一致（例如页面是 http://192.168.x.x:3000 则请求 http://192.168.x.x:3003），
   * 避免从局域网 IP 打开页面时请求 127.0.0.1 被浏览器拦截（Failed to fetch / TypeError）。
   */
  private getBridgeBaseUrl(): string {
    if (typeof window === 'undefined') return 'http://127.0.0.1:3003';
    const hostname = window.location.hostname;
    const h = hostname && hostname.length > 0 ? hostname : '127.0.0.1';
    return `http://${h}:3003`;
  }

  private bridgeOfflineError(): Error {
    const base = this.getBridgeBaseUrl();
    return new Error(
      `无法连接 ADB 桥接（${base}）。请在本机项目目录执行：npm start（或 npm run dev / npm run dev:bridge），看到「ADB server running」后保持窗口不关，再点「连接设备」或「重试连接」。`
    );
  }

  isSupported(): boolean {
    return true; // 本地 ADB 总是支持
  }

  /**
   * 判断是否为「根本连不上桥接」（含跨域/跨上下文导致 fetch 只报 Failed to fetch，不能用 instanceof TypeError 依赖）。
   */
  private isBridgeUnreachable(err: unknown): boolean {
    const msg = (err instanceof Error ? err.message : String(err)).toLowerCase();
    const name = err instanceof Error ? err.name : '';
    return (
      name === 'TypeError' ||
      /failed to fetch|load failed|networkerror|network request failed|fetch.*fail|connection refused|econnrefused|无法连接|networkerror/i.test(
        msg
      )
    );
  }

  /** 连接前确认桥接进程已启动（优先 /api/health；旧版桥接无该接口时改用 adb version） */
  private async ensureBridge(): Promise<void> {
    try {
      const r = await fetch(`${this.getBridgeBaseUrl()}/api/health`, { cache: 'no-store' });
      if (r.ok) return;
      if (r.status === 404) {
        const r2 = await fetch(
          `${this.getBridgeBaseUrl()}/api/adb?command=${encodeURIComponent('adb version')}`,
          { cache: 'no-store' }
        );
        if (r2.ok) return;
        const t2 = await r2.text().catch(() => '');
        throw new Error(t2?.trim() || `桥接异常 HTTP ${r2.status}`);
      }
      const t = await r.text().catch(() => '');
      throw new Error(t?.trim() || `桥接服务异常（HTTP ${r.status}）`);
    } catch (e) {
      if (this.isBridgeUnreachable(e)) {
        throw this.bridgeOfflineError();
      }
      throw e;
    }
  }

  async connect(): Promise<DeviceInfo> {
    try {
      console.log('开始连接本地 ADB...');
      await this.ensureBridge();

      const listText = await this.execShell('adb devices', { skipSerialInject: true });
      console.log('ADB devices 结果:', listText);

      const { authorized, unauthorized, offline } = this.parseAdbDevices(listText);

      if (authorized.length === 0) {
        this.connected = false;
        this.deviceSerial = null;
        if (unauthorized.length > 0) {
          throw new Error(
            '检测到设备但未授权 USB 调试：请在手机上点击「允许 USB 调试」并勾选「一律允许」后，再点「连接设备」。'
          );
        }
        if (offline.length > 0) {
          const ids = offline.join(', ');
          throw new Error(
            `ADB 已看到设备（序列号：${ids}），但状态是 offline，不是 device。` +
              '只要仍是 offline，本工具和命令行里的 adb shell / 截图都无法使用，并不是网页单独连不上。' +
              '请依次尝试：① 换 USB 线/USB 口（优先直连电脑，勿用劣质 Hub）；② 手机通知栏把 USB 用途改为「文件传输/MTP」；' +
              '③ 开发者选项里关闭再打开「USB 调试」，或「撤销 USB 调试授权」后重插线并在手机上点允许；' +
              '④ 终端执行 adb kill-server && adb start-server 后再执行 adb devices，直到该设备一列显示为 device。'
          );
        }
        throw new Error(
          '未检测到状态为 device 的设备。请在终端执行 adb devices：必须出现一行「序列号 + 空格 + device」（不能是 offline / unauthorized）。'
        );
      }

      const serial = authorized[0];
      this.deviceSerial = serial;
      this.connected = true;

      let model = '';
      let manufacturer = '';
      let batteryLevel = 50;

      try {
        model = (await this.getProp('ro.product.model')).trim();
        manufacturer = (await this.getProp('ro.product.manufacturer')).trim();
        batteryLevel = await this.getBatteryLevel();
        console.log('设备型号:', model, '厂商:', manufacturer, '电量:', batteryLevel);
      } catch (e) {
        console.error('获取设备属性失败（仍视为已连接该序列号）:', e);
      }

      const modelDisplay = model || '型号未识别';
      const mfrDisplay = manufacturer || '未知厂商';
      let name = `${mfrDisplay} ${modelDisplay}`.trim();
      if (!model && !manufacturer) {
        name = `已连接设备（${serial}）`;
      }

      const multiDeviceHint =
        authorized.length > 1
          ? `本机共 ${authorized.length} 台可用，当前使用该序列号：${serial}（其余请断开或后续支持多机切换）`
          : undefined;

      return {
        serial,
        id: serial,
        name,
        model: modelDisplay,
        status: 'connected',
        batteryLevel,
        multiDeviceHint,
      };
    } catch (e: unknown) {
      console.error('连接失败:', e);
      this.connected = false;
      this.deviceSerial = null;
      if (e instanceof Error) throw e;
      throw new Error(String(e));
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
    this.deviceSerial = null;
  }

  async sendKeyEvent(keyCode: number): Promise<void> {
    await this.execShell(`adb shell input keyevent ${keyCode}`);
  }

  async tap(x: number, y: number): Promise<void> {
    await this.execShell(`adb shell input tap ${x} ${y}`);
  }

  async inputText(text: string): Promise<void> {
    const escaped = text.replace(/ /g, '%s');
    await this.execShell(`adb shell input text "${escaped}"`);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    if (direction === 'up') {
      await this.execShell(`adb shell input swipe 500 1500 500 500 300`);
    } else if (direction === 'down') {
      await this.execShell(`adb shell input swipe 500 500 500 1500 300`);
    } else if (direction === 'left') {
      await this.execShell(`adb shell input swipe 800 1000 200 1000 300`);
    } else if (direction === 'right') {
      await this.execShell(`adb shell input swipe 200 1000 800 1000 300`);
    }
  }

  async terminateApp(packageName: string): Promise<void> {
    await this.execShell(`adb shell am force-stop ${packageName}`);
  }

  async getBatteryLevel(): Promise<number> {
    try {
      const output = await this.execShell('adb shell dumpsys battery');
      const match = output.match(/level:\s*(\d+)/);
      return match ? parseInt(match[1], 10) : 50;
    } catch (e) { return 50; }
  }

  /**
   * 栈顶 Activity：与命令行一致，在设备 shell 内管道过滤首行
   * adb shell "dumpsys activity | grep -E 'topActivity|mResumedActivity' | head -1"
   */
  async getTopActivity(): Promise<AppStackInfo | null> {
    try {
      const output = await this.execShell(
        `adb shell "dumpsys activity | grep -E 'topActivity|mResumedActivity' | head -1"`
      );
      const line = (output || '').trim().split(/\r?\n/)[0]?.trim() ?? '';
      if (!line) {
        return { packageName: 'System', activityName: 'Unknown', taskId: 0, isRunning: false, topActivityRawLine: '' };
      }
      const parsed = this.parseTopActivityLine(line);
      return { ...parsed, topActivityRawLine: line };
    } catch (e) {
      return null;
    }
  }

  /** 解析 dumpsys activity 单行中的包名与 Activity（多版本 ROM 兼容） */
  private parseTopActivityLine(line: string): Omit<AppStackInfo, 'topActivityRawLine'> {
    let pkg = '';
    let activity = '';
    let taskId = 0;
    const taskMatch = line.match(/\bt(\d+)\b/);
    if (taskMatch) taskId = parseInt(taskMatch[1], 10) || 0;

    const u0 = line.match(/u0\s+([^\s\/]+)\/([^\s\}\]]+)/);
    if (u0) {
      pkg = u0[1];
      activity = u0[2];
    }
    if (!pkg) {
      const comp = line.match(/ComponentInfo\{([^\/}]+)\/([^}]+)\}/);
      if (comp) {
        pkg = comp[1];
        activity = comp[2];
      }
    }
    if (!pkg) {
      const loose = line.match(/([a-zA-Z][a-zA-Z0-9_.]*)\/(\.?[a-zA-Z][a-zA-Z0-9_.]*)/);
      if (loose) {
        pkg = loose[1];
        activity = loose[2];
      }
    }
    if (activity.startsWith('.')) activity = pkg + activity;
    if (pkg && activity) {
      return { packageName: pkg, activityName: activity, taskId, isRunning: true };
    }
    return { packageName: 'System', activityName: 'Launcher', taskId, isRunning: false };
  }

  async getEnvironment(packageName?: string): Promise<AppEnvInfo | null> {
    try {
      const deviceVer = await this.getProp('ro.build.version.release');
      const deviceSdk = await this.getProp('ro.build.version.sdk');
      const deviceAndroidVersion = deviceVer?.trim() ?? '';
      const deviceSdkVersion = parseInt(deviceSdk?.trim() ?? '0', 10) || 0;

      if (packageName && packageName !== 'com.android.launcher' && packageName !== 'com.android.systemui') {
        const dump = await this.execShell(`adb shell dumpsys package ${packageName}`);
        const versionNameMatch = dump.match(/versionName=([^\s]+)/);
        const versionCodeMatch = dump.match(/versionCode=(\d+)/) || dump.match(/versionCodeLong=(\d+)/);
        const debuggableMatch = dump.match(/flags=[^\n]*DEBUGGABLE/);
        const targetSdkMatch = dump.match(/targetSdk(?:Version)?[=:]?\s*(\d+)/i) || dump.match(/targetSdk=(\d+)/);
        const minSdkMatch = dump.match(/minSdk(?:Version)?[=:]?\s*(\d+)/i) || dump.match(/minSdk=(\d+)/);
        const versionName = versionNameMatch ? versionNameMatch[1].trim() : '';
        const versionCode = versionCodeMatch ? parseInt(versionCodeMatch[1], 10) : 0;
        const debuggable = !!debuggableMatch;
        const targetSdkVersion = targetSdkMatch ? parseInt(targetSdkMatch[1], 10) : undefined;
        const minSdkVersion = minSdkMatch ? parseInt(minSdkMatch[1], 10) : undefined;
        let environment: AppEnvInfo['environment'] = 'PRODUCTION';
        if (/debug|dev|alpha|internal/i.test(versionName)) environment = 'DEVELOPMENT';
        else if (/staging|stg|beta|uat/i.test(versionName)) environment = 'STAGING';
        return {
          environment,
          versionCode,
          versionName: versionName || `Android ${deviceAndroidVersion}`,
          debuggable,
          targetSdkVersion,
          minSdkVersion,
          deviceAndroidVersion,
          deviceSdkVersion
        };
      }
      return {
        environment: 'UNKNOWN',
        versionCode: deviceSdkVersion,
        versionName: `Android ${deviceAndroidVersion}`,
        debuggable: true,
        deviceAndroidVersion,
        deviceSdkVersion
      };
    } catch (e) { return null; }
  }

  /**
   * 归一化 dumpsys 中截出的 URL（尽量保留完整 query / hash）。
   */
  private normalizeUrlCandidate(raw: string): string | null {
    let s = raw.trim();
    if (!s) return null;
    s = s.replace(/^[`'"'<]+/g, '').replace(/[`'"'),\];}>]+$/g, '').trim();
    s = s.replace(/\\u003d/gi, '=').replace(/\\u0026/gi, '&').replace(/\\\//g, '/');
    if (!/^https?:\/\//i.test(s) && !/^file:\/\//i.test(s)) return null;
    try {
      return new URL(s).href;
    } catch {
      return s;
    }
  }

  /** 从多段 dumpsys 文本中提取 http(s)/file 完整链接 */
  private extractHttpLikeUrls(text: string): string[] {
    const found = new Set<string>();
    if (!text) return [];

    const push = (raw: string) => {
      const n = this.normalizeUrlCandidate(raw);
      if (n) found.add(n);
    };

    let m: RegExpExecArray | null;
    const reHttp = /\bhttps?:\/\/[^\s\)\]\}\"\'\<\>]{4,}/gi;
    while ((m = reHttp.exec(text)) !== null) push(m[0]);

    const reFile = /\bfile:\/\/[^\s\)\]\}\"\'\<\>]{4,}/gi;
    while ((m = reFile.exec(text)) !== null) push(m[0]);

    const reQuoted = /["'](https?:\/\/[^"'\\]{4,})["']/gi;
    while ((m = reQuoted.exec(text)) !== null) push(m[1]);

    const reKv =
      /\b(?:mUrl|mOriginalUrl|HistoryUrl|baseUrl|loadedUrl|originalUrl|url|Url)\s*[=:]\s*"?([^"\s]+)"?/gi;
    while ((m = reKv.exec(text)) !== null) {
      const v = m[1];
      if (/^https?:\/\//i.test(v) || /^file:\/\//i.test(v)) push(v);
    }

    return Array.from(found);
  }

  /**
   * 优先从含 mUrl / HistoryUrl 等关键字的行取 URL，否则取长匹配（常为完整 H5 地址）。
   */
  private pickPrimaryWebUrl(topDump: string, combined: string, candidates: string[]): string | null {
    const key = /mUrl|mOriginalUrl|HistoryUrl|XWalkUri|loadedUrl|SW[-_]?URL|currentUrl|originalUrl/i;
    const scan = (blob: string): string | null => {
      for (const line of blob.split(/\r?\n/)) {
        if (!key.test(line)) continue;
        const mh = line.match(/https?:\/\/[^\s\)\]\}\"\'\<\>]+/i);
        if (mh) {
          const n = this.normalizeUrlCandidate(mh[0]);
          if (n) return n;
        }
        const mf = line.match(/file:\/\/[^\s\)\]\}\"\'\<\>]+/i);
        if (mf) {
          const n = this.normalizeUrlCandidate(mf[0]);
          if (n) return n;
        }
      }
      return null;
    };
    const fromKeys = scan(topDump) ?? scan(combined);
    if (fromKeys) return fromKeys;
    if (candidates.length === 0) return null;
    return [...candidates].sort((a, b) => b.length - a.length)[0];
  }

  private extractPageTitleFromDump(text: string): string | null {
    const patterns = [
      /(?:title|mTitle|pageTitle)\s*[=:]\s*([^\n\r]{1,240})/i,
      /mTitle[^:]*:\s*([^\n\r]{1,240})/i,
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m?.[1]) {
        let s = m[1].trim().replace(/^["']|["']$/g, '');
        if (s.length > 120) s = s.slice(0, 120) + '…';
        return s || null;
      }
    }
    return null;
  }

  private extractWebViewUserAgent(text: string): string | null {
    const m =
      text.match(/(?:WebView\s+)?User[-_]?Agent[=:\s]+([^\n\r]{10,520})/i) ||
      text.match(/\bmUserAgent[=:\s]+([^\n\r]{10,520})/i);
    if (m?.[1]) {
      const s = m[1].trim().replace(/^["']|["']$/g, '');
      if (/Mozilla|Chrome|WebKit|AppleWebKit|Version\/|wv\)/i.test(s)) {
        return s.slice(0, 512);
      }
    }
    return null;
  }

  private async getFallbackLinuxUa(): Promise<string> {
    try {
      const v = (await this.getProp('ro.build.version.release')).trim();
      return `Mozilla/5.0 (Linux; Android ${v || '?'}) AppleWebKit/537.36`;
    } catch {
      return '';
    }
  }

  /**
   * WebView / H5 地址：合并 activity top、activities、window 及当前包相关片段，解析完整 URL 与候选列表。
   */
  async getH5Info(packageName?: string): Promise<H5Info | null> {
    try {
      const chunks: string[] = [];
      let top = '';
      try {
        top = await this.execShell('adb shell dumpsys activity top');
        chunks.push(top);
      } catch {
        top = '';
      }

      const tryAppend = async (cmd: string) => {
        try {
          const o = await this.execShell(cmd);
          if (o && o.trim().length > 10) chunks.push(o);
        } catch {
          /* ROM 差异或命令超长 */
        }
      };

      await tryAppend('adb shell dumpsys activity activities | head -n 800');
      await tryAppend('adb shell dumpsys window windows | head -n 280');

      const safePkg = (packageName || '').trim();
      if (/^[a-zA-Z0-9_.]+$/.test(safePkg)) {
        await tryAppend(
          `adb shell dumpsys activity activities 2>/dev/null | grep -F "${safePkg}" | head -n 160`
        );
      }

      const combined = chunks.join('\n\n');
      const candidates = this.extractHttpLikeUrls(combined);
      const primary = this.pickPrimaryWebUrl(top, combined, candidates);

      const ordered =
        primary != null
          ? [primary, ...candidates.filter((u) => u !== primary)]
          : [...candidates].sort((a, b) => b.length - a.length);

      const pageTitle = this.extractPageTitleFromDump(combined);
      const webViewUa = this.extractWebViewUserAgent(combined);
      const userAgent = webViewUa || (await this.getFallbackLinuxUa());

      return {
        currentUrl: primary ?? ordered[0] ?? null,
        pageTitle: pageTitle ?? null,
        userAgent,
        urlCandidates: ordered.length > 0 ? ordered : undefined,
        webViewUserAgent: webViewUa,
      };
    } catch {
      return { currentUrl: null, pageTitle: null, userAgent: '' };
    }
  }

  async getLayoutHierarchy(): Promise<LayoutNode | null> {
    try {
      await this.execShell('adb shell uiautomator dump /sdcard/window_dump.xml');
      const raw = await this.execShell('adb shell cat /sdcard/window_dump.xml');
      if (!raw || raw.length < 50) return null;
      const parser = new DOMParser();
      const doc = parser.parseFromString(raw, 'text/xml');
      const root = doc.querySelector('hierarchy > node');
      if (!root) return null;

      const parseNode = (el: Element): LayoutNode => {
        const bounds = el.getAttribute('bounds') || '[0,0][0,0]';
        const cls = el.getAttribute('class') || 'unknown';
        const rid = el.getAttribute('resource-id') || '';
        const id = rid || (el.getAttribute('index') ?? '');
        const children: LayoutNode[] = [];
        Array.from(el.children).forEach((child) => {
          if (child.tagName === 'node') children.push(parseNode(child as Element));
        });
        return {
          id: id || cls,
          class: cls,
          bounds,
          children: children.length > 0 ? children : undefined
        };
      };
      return parseNode(root);
    } catch (e) {
      return null;
    }
  }

  /**
   * 在设备上打开 URL / 自定义 scheme（Deep Link）。
   * targetPackage：可选，传入时使用 am start -p 限定由指定应用处理（内部 scheme 常用）。
   * 示例: openUrl('myapp://detail/1', 'com.example.app')
   */
  async openUrl(url: string, targetPackage?: string): Promise<string> {
    try {
      const safe = url.replace(/"/g, '\\"').trim();
      if (!safe) throw new Error('URI 为空');
      const pkg = (targetPackage || '').trim();
      const pkgOk = /^[a-zA-Z][a-zA-Z0-9_.]*(\.[a-zA-Z0-9_.]+)+$/.test(pkg);
      const pkgArg = pkgOk ? ` -p ${pkg}` : '';
      const out = await this.execShell(
        `adb shell am start -a android.intent.action.VIEW -d "${safe}"${pkgArg}`
      );
      return out;
    } catch (e: any) {
      console.error('openUrl failed', e);
      throw e;
    }
  }

  async listAppDataDir(packageName: string): Promise<string> {
    try {
      // Try run-as to list databases for debuggable apps
      const cmd = `adb shell run-as ${packageName} ls -la /data/data/${packageName}/databases || adb shell ls -la /data/data/${packageName}`;
      const out = await this.execShell(cmd);
      return out;
    } catch (e: any) {
      throw new Error('Unable to list app data: ' + (e?.message || String(e)));
    }
  }

  async toggleLayoutBounds(): Promise<boolean> {
    try {
      // Best-effort toggle for layout bounds (may vary by Android version)
      const getOut = await this.execShell('adb shell settings get global debug_view_attributes || echo 0');
      const cur = /\d+/.exec(getOut)?.[0] ?? '0';
      const next = cur === '1' ? '0' : '1';
      await this.execShell(`adb shell settings put global debug_view_attributes ${next}`);
      return next === '1';
    } catch (e) {
      // Fallback: attempt to set view server property (best effort)
      try {
        await this.execShell('adb shell setprop debug.layout ' + (Math.random() > 0.5 ? '1' : '0'));
      } catch (_) {}
      return false;
    }
  }

  async toggleShowTaps(): Promise<boolean> {
    try {
      const getOut = await this.execShell('adb shell settings get system show_touches || echo 0');
      const cur = /\d+/.exec(getOut)?.[0] ?? '0';
      const next = cur === '1' ? '0' : '1';
      await this.execShell(`adb shell settings put system show_touches ${next}`);
      return next === '1';
    } catch (e) {
      throw new Error('toggleShowTaps failed: ' + (e instanceof Error ? e.message : String(e)));
    }
  }

  async clearAppData(packageName: string): Promise<void> {
    try {
      await this.execShell(`adb shell pm clear ${packageName}`);
    } catch (e: any) {
      throw new Error('clearAppData failed: ' + (e?.message || String(e)));
    }
  }

  async restartApp(packageName: string): Promise<void> {
    try {
      await this.execShell(`adb shell am force-stop ${packageName} && adb shell monkey -p ${packageName} -c android.intent.category.LAUNCHER 1`);
    } catch (e: any) {
      throw new Error('restartApp failed: ' + (e?.message || String(e)));
    }
  }

  async pushFile(file: File, devicePath: string): Promise<void> {
    try {
      const form = new FormData();
      form.append('path', devicePath);
      form.append('file', file, file.name);
      const resp = await fetch(`${this.getBridgeBaseUrl()}/api/push`, { method: 'POST', body: form });
      if (!resp.ok) throw new Error('push failed: ' + resp.statusText);
      return;
    } catch (e: any) {
      throw new Error('pushFile failed: ' + (e?.message || String(e)));
    }
  }

  async pullFile(devicePath: string): Promise<Blob> {
    try {
      const resp = await fetch(`${this.getBridgeBaseUrl()}/api/pull?path=${encodeURIComponent(devicePath)}`);
      if (!resp.ok) throw new Error('pull failed: ' + resp.statusText);
      const blob = await resp.blob();
      return blob;
    } catch (e: any) {
      throw new Error('pullFile failed: ' + (e?.message || String(e)));
    }
  }

  async captureAtrace(duration: number, categories: string[]): Promise<string> {
    try {
      const cats = categories && categories.length ? categories.join(' ') : '';
      // Run atrace on device and return stdout. This may require appropriate device support.
      const cmd = `adb shell atrace -t ${duration} ${cats}`;
      const out = await this.execShell(cmd);
      return out;
    } catch (e: any) {
      throw new Error('captureAtrace failed: ' + (e?.message || String(e)));
    }
  }

  subscribeLogs(callback: (log: LogEntry) => void): () => void {
    let stopped = false;
    const run = async () => {
        if (stopped) return;
        try {
            // 这里需要实现日志订阅
        } catch (e) {
            console.error("Logcat error", e);
        }
    };
    run();
    return () => { stopped = true; };
  }

  async captureScreen(): Promise<string> {
    try {
      const serialQ = this.deviceSerial
        ? `&serial=${encodeURIComponent(this.deviceSerial)}`
        : '';
      const response = await fetch(
        `${this.getBridgeBaseUrl()}/api/screen?t=${Date.now()}${serialQ}`,
        {
        cache: 'no-store',
        }
      );
      if (!response.ok) {
        const errText = await response.text().catch(() => '');
        throw new Error(errText || `截图失败 HTTP ${response.status}`);
      }
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch (e) {
      if (this.isBridgeUnreachable(e)) {
        throw this.bridgeOfflineError();
      }
      if (e instanceof Error) throw e;
      throw new Error('截图失败');
    }
  }

  private async execShell(
    command: string,
    options?: { skipSerialInject?: boolean }
  ): Promise<string> {
    const effective = options?.skipSerialInject ? command : this.formatAdbCommand(command);
    console.log('执行命令:', effective);
    let response: Response;
    try {
      response = await fetch(`${this.getBridgeBaseUrl()}/api/adb?command=${encodeURIComponent(effective)}`, {
        cache: 'no-store',
      });
    } catch (e) {
      console.error('请求失败:', e);
      if (this.isBridgeUnreachable(e)) {
        throw this.bridgeOfflineError();
      }
      throw e instanceof Error ? e : new Error(String(e));
    }

    const text = await response.text();
    if (!response.ok) {
      const hint = text?.trim() || `桥接执行失败（HTTP ${response.status}）`;
      throw new Error(hint);
    }
    console.log('响应状态:', response.status);
    return text;
  }

  private async getProp(name: string): Promise<string> {
      const out = await this.execShell(`adb shell getprop ${name}`);
      return out.trim();
  }
}

export const localAdbService = new LocalAdbService();