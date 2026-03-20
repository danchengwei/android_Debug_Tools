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
  /** 与 vite.config 中开发端口、默认 preview 端口一致：这些端口上同源 /api 会由 Vite 代理到 adb-server */
  private isViteManagedUiPort(port: string): boolean {
    return port === '3000' || port === '4173';
  }

  /** 含 IPv6 回环（避免 [::1] 被误判成「非回环」去直连 :3003） */
  private isLoopbackHost(hostname: string): boolean {
    const h = (hostname || '').toLowerCase().replace(/^\[|\]$/g, '');
    return h === '127.0.0.1' || h === 'localhost' || h === '::1';
  }

  private getBridgeBaseUrl(): string {
    if (typeof window === 'undefined') return 'http://127.0.0.1:3003';
    const { port, hostname } = window.location;
    const h = hostname && hostname.length > 0 ? hostname : '127.0.0.1';
    /**
     * 页面在 Vite 托管端口时：桥接一律走同源「/api」，由 vite 代理到 127.0.0.1:3003。
     * 若用手机访问电脑局域网 IP，必须让 Vite 监听 0.0.0.0（勿用仅 127.0.0.1），否则页面根本打不开。
     */
    if (this.isViteManagedUiPort(port)) {
      return '';
    }
    return `http://${h}:3003`;
  }

  /**
   * 依次尝试的桥接基址。
   * 开发/预览端口上：**优先「当前页面主机:3003」直连 adb-server**（与 listen 0.0.0.0 配合），再试同源 /api。
   * 原因：部分环境下 Vite 内置代理或中间件未命中时，/api 会落静态层返回 HTML 404；直连 3003 与代理无关，最稳。
   * 手机用电脑局域网 IP 打开时，主机已是电脑 IP，不会误用 127.0.0.1（127.0.0.1 仅作本机回环页的兜底）。
   */
  private getBridgeFetchBases(): string[] {
    const m = this.getBridgeBaseUrl();
    const host =
      typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '';
    const onLoopback = this.isLoopbackHost(host);
    const out: string[] = [];

    if (m === '') {
      if (host) {
        out.push(`http://${host}:3003`);
      }
      out.push('');
      if (onLoopback || !host) {
        out.push('http://127.0.0.1:3003');
      }
    } else {
      out.push(m);
      if (host && !onLoopback && !m.includes(`${host}:3003`)) {
        out.push(`http://${host}:3003`);
      }
      if (
        onLoopback &&
        !/^https?:\/\/127\.0\.0\.1:3003\/?$/i.test(m) &&
        !/^https?:\/\/localhost:3003\/?$/i.test(m)
      ) {
        out.push('http://127.0.0.1:3003');
      }
    }
    return [...new Set(out)];
  }

  /**
   * 对桥接发 GET：404 / 502 / 503 / 504 时换下一基址重试（代理未命中、桥接短暂不可达时避免直接失败）。
   */
  private shouldRetryBridgeFetch(status: number): boolean {
    return status === 404 || status === 502 || status === 503 || status === 504;
  }

  /**
   * 请求本机桥接在本机电脑上打开 Chrome 的「远程调试 / inspect」页（chrome:// 无法由网页直接打开）。
   */
  async openDesktopChromeInspect(): Promise<boolean> {
    const path = '/api/open-desktop-inspect';
    for (const base of this.getBridgeFetchBases()) {
      const url = base === '' ? path : `${base.replace(/\/$/, '')}${path}`;
      try {
        const r = await fetch(url, { method: 'POST', cache: 'no-store' });
        if (r.ok) {
          const j = (await r.json().catch(() => ({}))) as { ok?: boolean };
          return j.ok !== false;
        }
      } catch {
        /* 换下一基址 */
      }
    }
    return false;
  }

  /** 当前已绑定设备序列号（未连接时为 null） */
  getCurrentSerial(): string | null {
    return this.deviceSerial;
  }

  private async bridgePostJson(path: string, body: Record<string, unknown>): Promise<Response> {
    const p = path.startsWith('/') ? path : `/${path}`;
    let last: Response | undefined;
    for (const base of this.getBridgeFetchBases()) {
      const url = base === '' ? p : `${base.replace(/\/$/, '')}${p}`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json; charset=utf-8' },
          body: JSON.stringify(body),
          cache: 'no-store',
        });
        last = r;
        if (!this.shouldRetryBridgeFetch(r.status)) return r;
      } catch {
        /* 换下一基址 */
      }
    }
    return last ?? new Response('', { status: 503, statusText: 'Bridge unreachable' });
  }

  private async bridgePostBinary(pathWithQuery: string, buffer: ArrayBuffer, contentType: string): Promise<Response> {
    const p = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
    let last: Response | undefined;
    for (const base of this.getBridgeFetchBases()) {
      const url = base === '' ? p : `${base.replace(/\/$/, '')}${p}`;
      try {
        const r = await fetch(url, {
          method: 'POST',
          headers: { 'Content-Type': contentType || 'application/octet-stream' },
          body: buffer,
          cache: 'no-store',
        });
        last = r;
        if (!this.shouldRetryBridgeFetch(r.status)) return r;
      } catch {
        /* 换下一基址 */
      }
    }
    return last ?? new Response('', { status: 503, statusText: 'Bridge unreachable' });
  }

  private async bridgeGet(pathWithQuery: string): Promise<Response> {
    const path = pathWithQuery.startsWith('/') ? pathWithQuery : `/${pathWithQuery}`;
    let last: Response | undefined;
    for (const base of this.getBridgeFetchBases()) {
      const url = base === '' ? path : `${base.replace(/\/$/, '')}${path}`;
      try {
        const r = await fetch(url, { cache: 'no-store' });
        last = r;
        if (!this.shouldRetryBridgeFetch(r.status)) return r;
      } catch {
        /* 换下一基址 */
      }
    }
    return last ?? new Response('', { status: 503, statusText: 'Bridge unreachable' });
  }

  private bridgeOfflineError(): Error {
    return new Error(
      '无法连接本机调试服务。请先在电脑上双击「启动调试工具」完成启动，并保持该窗口不关，再点「连接设备」或「重试连接」。'
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
      const r = await this.bridgeGet('/api/health');
      if (r.ok) return;
      if (r.status === 404) {
        const r2 = await this.bridgeGet(
          `/api/adb?command=${encodeURIComponent('adb version')}`
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

  /**
   * 多机时 adb devices 顺序不稳定；Chrome Inspect 会列出所有设备让你选，我们若永远取第一行可能是 emulator，
   * 真机在跑 H5 时就会出现「Inspect 有、本工具没有」。
   */
  private pickPreferredDeviceSerial(authorized: string[]): string {
    if (authorized.length <= 1) return authorized[0];
    const nonEmu = authorized.filter((s) => !/^emulator-\d+$/i.test(s.trim()));
    return nonEmu.length > 0 ? nonEmu[0] : authorized[0];
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

      const serial = this.pickPreferredDeviceSerial(authorized);
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
          ? `本机共 ${authorized.length} 台 device；已自动优先非模拟器序列号：${serial}（若 H5 仍空，请关掉 emulator-* 或只插一台真机后再连）`
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

  /**
   * 用界面当前「已连接设备」的序列号写回单例。
   * Vite 热更新会重建本类实例，内部 deviceSerial 会丢，但 React 仍显示已连接，此时 H5 桥接会误报「未选中设备」。
   */
  rebindDeviceSerial(serial: string | undefined | null): void {
    const s = (serial || '').trim();
    if (!s || !/^[\w.:+-]+$/.test(s)) return;
    this.deviceSerial = s;
    this.connected = true;
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
    // 协议相对链接 //example.com/path → https:
    if (/^\/\//.test(s)) s = `https:${s}`;
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

    // JSON / 配置里常见的 "url":"https://..."
    const reJsonUrl = /["']url["']\s*:\s*["'](https?:\/\/[^"'\\]{4,})["']/gi;
    while ((m = reJsonUrl.exec(text)) !== null) push(m[1]);

    // 协议相对（在 normalize 里补全 https:）
    const reProtoRel =
      /\b(https?:)?\/\/[a-zA-Z0-9][-a-zA-Z0-9.+_]{0,63}\.[a-zA-Z][-a-zA-Z0-9.+_:/%?#&=@]{3,}/gi;
    while ((m = reProtoRel.exec(text)) !== null) push(m[0]);

    const reKv =
      /\b(?:mUrl|mOriginalUrl|HistoryUrl|baseUrl|loadedUrl|originalUrl|lastCommittedUrl|committedUrl|visibleUrl|navigationUrl|url|Url)\s*[=:]\s*"?([^"\s]+)"?/gi;
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
    const key =
      /mUrl|mOriginalUrl|HistoryUrl|XWalkUri|loadedUrl|loadUrl|SW[-_]?URL|currentUrl|originalUrl|lastCommittedUrl|committedUrl|visibleUrl|navigationUrl|Crosswalk|XWalk/i;
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
   * 通过桥接 /api/webview-pages 读取 DevTools /json。
   * 不传 package 或包名为 System 时由服务端按 dumpsys 前台包名 + 全机套接字扫描兜底。
   */
  private async fetchWebViewDevtoolsPages(packageName: string): Promise<{
    pages: { url: string; title: string | null }[];
  }> {
    const serial = this.deviceSerial;
    if (!serial) {
      return { pages: [] };
    }
    const pkg = (packageName || '').trim();
    const params = new URLSearchParams({ serial });
    const sendPkg =
      pkg.length > 0 &&
      pkg !== 'System' &&
      pkg !== 'com.android.launcher' &&
      /^[a-zA-Z0-9_.]+$/.test(pkg);
    if (sendPkg) params.set('package', pkg);
    try {
      const r = await this.bridgeGet(`/api/webview-pages?${params.toString()}`);
      const textRaw = await r.text();
      type PageRow = { url: string; title?: string | null };
      let pages: PageRow[] = [];
      try {
        const parsed: unknown = JSON.parse(textRaw);
        if (Array.isArray(parsed)) {
          pages = parsed as PageRow[];
        } else if (
          parsed &&
          typeof parsed === 'object' &&
          Array.isArray((parsed as { pages?: PageRow[] }).pages)
        ) {
          pages = (parsed as { pages: PageRow[] }).pages;
        }
      } catch {
        return { pages: [] };
      }
      const filtered = pages
        .filter((p) => p && typeof p.url === 'string' && p.url.length > 0)
        .map((p) => ({ url: p.url.trim(), title: p.title ?? null }));
      if (filtered.length > 0) {
        return { pages: filtered };
      }
      if (!r.ok) {
        return { pages: [] };
      }
      return { pages: [] };
    } catch {
      return { pages: [] };
    }
  }

  /**
   * WebView / H5 地址：合并 activity top、activities、window 及当前包相关片段，解析完整 URL 与候选列表。
   */
  async getH5Info(packageName?: string): Promise<H5Info | null> {
    const safePkg = (packageName || '').trim();
    let devtoolsPages: { url: string; title: string | null }[] = [];
    try {
      devtoolsPages = (await this.fetchWebViewDevtoolsPages(safePkg)).pages;
    } catch {
      devtoolsPages = [];
    }

    const buildFromDevtoolsOnly = (): H5Info => {
      const dtUrls = devtoolsPages.map((p) => p.url).filter((u) => u && u.length > 2);
      const primary =
        dtUrls.find((u) => /^https?:\/\//i.test(u) && !/^about:/i.test(u)) ||
        dtUrls.find((u) => /^https?:\/\//i.test(u)) ||
        dtUrls.find((u) => /^file:\/\//i.test(u)) ||
        dtUrls[0] ||
        null;
      const dtTitle = devtoolsPages.find((p) => p.title && p.title.trim())?.title?.trim() ?? null;
      return {
        currentUrl: primary,
        pageTitle: dtTitle,
        userAgent: '',
        urlCandidates: dtUrls.length > 0 ? dtUrls : undefined,
        webViewUserAgent: null,
      };
    };

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

      await tryAppend('adb shell dumpsys activity activities | head -n 3000');
      await tryAppend('adb shell dumpsys window windows | head -n 400');

      /** 在设备 shell 内管道过滤（不依赖本机 grep/head，Windows 桥接也可用） */
      await tryAppend(
        'adb shell "dumpsys activity top 2>/dev/null | grep -iE \'https?://|file://|mUrl|mOriginalUrl|HistoryUrl|lastCommitted|loadedUrl|url=\' | head -n 220"'
      );
      await tryAppend(
        'adb shell "dumpsys activity activities 2>/dev/null | grep -iE \'https?://|file://|mUrl|HistoryUrl|loadedUrl|lastCommitted|navigationUrl|loadUrl|originalUrl\' | head -n 480"'
      );
      await tryAppend('adb shell "dumpsys webview 2>/dev/null | head -n 500"');

      if (/^[a-zA-Z0-9_.]+$/.test(safePkg)) {
        await tryAppend(
          `adb shell dumpsys activity activities 2>/dev/null | grep -F "${safePkg}" | head -n 160`
        );
        await tryAppend(
          `adb shell "dumpsys activity top 2>/dev/null | grep -F ${safePkg} | head -n 120"`
        );
      }

      const combined = chunks.join('\n\n');
      const dumpCandidates = this.extractHttpLikeUrls(combined);

      const dtUrls = devtoolsPages.map((p) => p.url).filter((u) => u && u.length > 2);
      const mergedSet = new Set<string>([...dtUrls, ...dumpCandidates]);
      const mergedCandidates = Array.from(mergedSet);

      const dtPrimary =
        dtUrls.find((u) => /^https?:\/\//i.test(u) && !/^about:/i.test(u)) ||
        dtUrls.find((u) => /^https?:\/\//i.test(u)) ||
        dtUrls.find((u) => /^file:\/\//i.test(u)) ||
        dtUrls[0] ||
        null;
      const dumpPrimary = this.pickPrimaryWebUrl(top, combined, dumpCandidates);
      const primary = dtPrimary ?? dumpPrimary;

      const ordered =
        primary != null
          ? [primary, ...mergedCandidates.filter((u) => u !== primary)]
          : [...mergedCandidates].sort((a, b) => b.length - a.length);

      const dtTitle = devtoolsPages.find((p) => p.title && p.title.trim())?.title?.trim() ?? null;
      const pageTitle = dtTitle ?? this.extractPageTitleFromDump(combined);
      const webViewUa = this.extractWebViewUserAgent(combined);
      let userAgent = webViewUa || '';
      try {
        if (!userAgent) userAgent = await this.getFallbackLinuxUa();
      } catch {
        if (!userAgent) userAgent = '';
      }

      const finalUrl = primary ?? ordered[0] ?? null;

      return {
        currentUrl: finalUrl,
        pageTitle: pageTitle ?? null,
        userAgent,
        urlCandidates: ordered.length > 0 ? ordered : undefined,
        webViewUserAgent: webViewUa,
      };
    } catch {
      const fallback = buildFromDevtoolsOnly();
      if (fallback.currentUrl || (fallback.urlCandidates && fallback.urlCandidates.length > 0)) {
        try {
          fallback.userAgent = await this.getFallbackLinuxUa();
        } catch {
          /* 忽略 */
        }
        return fallback;
      }
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

  private requireSerialOrThrow(): string {
    const s = this.deviceSerial;
    if (!s) {
      throw new Error('未连接设备');
    }
    return s;
  }

  /**
   * 上传 APK 并 adb install -r（经桥接流式转发，大包请稍候）。
   */
  async installApkFromFile(file: File): Promise<{ ok: boolean; output: string }> {
    const serial = this.requireSerialOrThrow();
    const buf = await file.arrayBuffer();
    const q = `/api/install-apk?serial=${encodeURIComponent(serial)}`;
    const r = await this.bridgePostBinary(q, buf, 'application/vnd.android.package-archive');
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; output?: string; message?: string };
    const output = (j.output || j.message || '').trim() || `HTTP ${r.status}`;
    if (!r.ok && r.status >= 400) {
      throw new Error(output);
    }
    return { ok: j.ok !== false && r.ok, output };
  }

  /**
   * 从桥接进程工作目录（一般为项目根）安装相对路径 APK，例如 app/build/outputs/apk/debug/app-debug.apk
   */
  async installApkFromProjectRelativePath(relativePath: string): Promise<{ ok: boolean; output: string }> {
    const serial = this.requireSerialOrThrow();
    const r = await this.bridgePostJson('/api/install-apk-from-path', {
      serial,
      relativePath: relativePath.trim(),
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; output?: string; message?: string };
    const output = (j.output || j.message || '').trim() || `HTTP ${r.status}`;
    if (!r.ok) {
      throw new Error(output);
    }
    return { ok: !!j.ok, output };
  }

  /** 仅清缓存（pm clear 的轻量替代，需系统支持 cmd package clear-cache） */
  async clearAppCacheOnly(packageName: string): Promise<string> {
    const serial = this.requireSerialOrThrow();
    const r = await this.bridgePostJson('/api/clear-app-cache', { serial, package: packageName });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; output?: string; message?: string };
    const out = (j.output || j.message || '').trim();
    if (!j.ok) {
      throw new Error(out || '清缓存失败（部分系统不支持或包不存在）');
    }
    return out || 'OK';
  }

  /** ANR 目录、tombstone 抽样、crash buffer、dropbox 尾部等 */
  async fetchDebugArtifacts(): Promise<Record<string, string>> {
    const serial = this.requireSerialOrThrow();
    const r = await this.bridgePostJson('/api/debug-artifacts', { serial });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; parts?: Record<string, string>; message?: string };
    if (!j.ok || !j.parts) {
      throw new Error(j.message || '拉取诊断信息失败');
    }
    return j.parts;
  }

  async fetchGlobalHttpProxy(): Promise<string> {
    const serial = this.requireSerialOrThrow();
    const resp = await this.bridgeGet(`/api/http-proxy?serial=${encodeURIComponent(serial)}`);
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; proxy?: string; message?: string };
    if (!resp.ok || !j.ok) {
      throw new Error(j.message || '读取系统代理失败');
    }
    return (j.proxy ?? '').trim();
  }

  /** host:port 或 null/空字符串清除代理 */
  async setGlobalHttpProxy(hostPort: string | null | undefined): Promise<string> {
    const serial = this.requireSerialOrThrow();
    const proxy =
      hostPort == null || String(hostPort).trim() === '' ? '' : String(hostPort).trim();
    const r = await this.bridgePostJson('/api/http-proxy', { serial, proxy });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; message?: string };
    if (!j.ok) {
      throw new Error(j.message || '设置代理失败');
    }
    return j.message || 'OK';
  }

  async fetchPackagePermissionsSummary(packageName: string): Promise<{ summary: string; truncated: boolean }> {
    const serial = this.requireSerialOrThrow();
    const resp = await this.bridgeGet(
      `/api/package-permissions?serial=${encodeURIComponent(serial)}&package=${encodeURIComponent(packageName)}`
    );
    const j = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      summary?: string;
      truncated?: boolean;
      message?: string;
    };
    if (!resp.ok || !j.ok) {
      throw new Error(j.message || '获取权限摘要失败');
    }
    return { summary: j.summary ?? '', truncated: !!j.truncated };
  }

  async listRunAsSubdir(packageName: string, kind: 'databases' | 'shared_prefs'): Promise<string> {
    const serial = this.requireSerialOrThrow();
    const resp = await this.bridgeGet(
      `/api/run-as-list?serial=${encodeURIComponent(serial)}&package=${encodeURIComponent(packageName)}&kind=${encodeURIComponent(kind)}`
    );
    const j = (await resp.json().catch(() => ({}))) as { ok?: boolean; output?: string; message?: string };
    if (!resp.ok || !j.ok) {
      throw new Error(j.output || j.message || 'run-as 列出失败（需 debuggable）');
    }
    return j.output ?? '';
  }

  async downloadRunAsFile(packageName: string, relPath: string): Promise<Blob> {
    const serial = this.requireSerialOrThrow();
    const resp = await this.bridgeGet(
      `/api/run-as-file?serial=${encodeURIComponent(serial)}&package=${encodeURIComponent(packageName)}&relPath=${encodeURIComponent(relPath)}`
    );
    if (!resp.ok) {
      const t = await resp.text();
      let msg = t;
      try {
        const j = JSON.parse(t) as { message?: string };
        if (j?.message) msg = j.message;
      } catch {
        /* 非 JSON */
      }
      throw new Error(msg || `HTTP ${resp.status}`);
    }
    return resp.blob();
  }

  async runMonkey(packageName: string, events: number, throttleMs: number): Promise<string> {
    const serial = this.requireSerialOrThrow();
    const r = await this.bridgePostJson('/api/monkey', {
      serial,
      package: packageName,
      events,
      throttle: throttleMs,
    });
    const j = (await r.json().catch(() => ({}))) as { ok?: boolean; output?: string; message?: string };
    const out = (j.output || j.message || '').trim();
    if (!r.ok && r.status >= 500) {
      throw new Error(out || `HTTP ${r.status}`);
    }
    return out || (j.ok ? 'Monkey 结束' : 'Monkey 异常结束');
  }

  async fetchWebViewSummary(packageName?: string): Promise<{
    ok: boolean;
    socketCount: number;
    pageCount: number;
    hint: string;
  }> {
    const serial = this.requireSerialOrThrow();
    const pkgQ =
      packageName && packageName.length > 2
        ? `&package=${encodeURIComponent(packageName)}`
        : '';
    const resp = await this.bridgeGet(`/api/webview-summary?serial=${encodeURIComponent(serial)}${pkgQ}`);
    const j = (await resp.json().catch(() => ({}))) as {
      ok?: boolean;
      socketCount?: number;
      pageCount?: number;
      hint?: string;
      message?: string;
    };
    if (!resp.ok) {
      throw new Error(j.message || '获取 WebView 摘要失败');
    }
    return {
      ok: j.ok !== false,
      socketCount: j.socketCount ?? 0,
      pageCount: j.pageCount ?? 0,
      hint: j.hint ?? '',
    };
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
      const response = await this.bridgeGet(`/api/screen?t=${Date.now()}${serialQ}`);
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
      response = await this.bridgeGet(`/api/adb?command=${encodeURIComponent(effective)}`);
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