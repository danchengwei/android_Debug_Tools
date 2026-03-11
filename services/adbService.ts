import { Adb, AdbDaemonTransport } from '@yume-chan/adb';
import type { AdbCredentialStore, AdbPrivateKey } from '@yume-chan/adb';
import type { AdbDaemonConnection } from '@yume-chan/adb';
import { AdbWebUsbBackend, ADB_DEFAULT_DEVICE_FILTER } from '@yume-chan/adb-backend-webusb';
import { DeviceInfo, AppStackInfo, AppEnvInfo, H5Info, LayoutNode, LogEntry, LogLevel } from '../types';

/** 使用 Web Crypto API 生成并缓存的 RSA 私钥，供 ADB 认证使用 */
function createWebCryptoCredentialStore(): AdbCredentialStore {
  const keys: AdbPrivateKey[] = [];
  return {
    async generateKey(): Promise<AdbPrivateKey> {
      const keyPair = await crypto.subtle.generateKey(
        {
          name: 'RSASSA-PKCS1-v1_5',
          modulusLength: 2048,
          publicExponent: new Uint8Array([1, 0, 1]),
          hash: 'SHA-1'
        },
        true,
        ['sign']
      );
      const pkcs8 = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);
      const buffer = new Uint8Array(pkcs8);
      keys.push({ buffer });
      return { buffer };
    },
    iterateKeys(): AsyncIterable<AdbPrivateKey> {
      return (async function* () {
        for (const k of keys) yield k;
      })();
    }
  };
}

class AdbService {
  private device: any = null;
  private connected: boolean = false;

  isSupported(): boolean {
    return !!(typeof window !== 'undefined' && window.navigator && (window.navigator as any).usb);
  }

  /** 第一步：仅请求用户选择 USB 设备，不建立 ADB 连接。选完后手机会在「继续连接」时弹出授权。 */
  async requestDeviceOnly(): Promise<USBDevice> {
    const usb = (window.navigator as any).usb as USB;
    if (!usb) throw new Error('浏览器不支持 WebUSB');
    return usb.requestDevice({ filters: [] });
  }

  /** 第二步：用已选设备建立 ADB 连接。此时手机会弹出「允许 USB 调试」，需用户点允许后重试。 */
  async connectWithDevice(usbDevice: USBDevice): Promise<DeviceInfo> {
    const usb = (window.navigator as any).usb as USB;
    if (!usb) throw new Error('浏览器不支持 WebUSB');

    const credentialStore = createWebCryptoCredentialStore();
    const maxAttempts = 3;
    let lastError: any;

    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      try {
        const backend = new AdbWebUsbBackend(usbDevice, [ADB_DEFAULT_DEVICE_FILTER], usb);
        const connection = await backend.connect() as unknown as AdbDaemonConnection;
        const transport = await AdbDaemonTransport.authenticate({
          serial: backend.serial,
          connection,
          credentialStore
        });

        this.device = new Adb(transport);
        this.connected = true;

        const model = await this.getProp('ro.product.model');
        const manufacturer = await this.getProp('ro.product.manufacturer');
        return {
          id: usbDevice.serialNumber || 'usb-device',
          name: `${manufacturer} ${model}`.trim() || 'Android 设备',
          model: model?.trim() || '',
          status: 'connected',
          batteryLevel: await this.getBatteryLevel()
        };
      } catch (e: any) {
        lastError = e;
        const isNetworkLike =
          e?.name === 'NetworkError' ||
          e?.message?.includes('NetworkError') ||
          /network|transfer|failed to open/i.test(e?.message || '');
        if (attempt < maxAttempts && isNetworkLike) {
          await new Promise((r) => setTimeout(r, 8000));
          continue;
        }
        throw e;
      }
    }
    throw lastError;
  }

  /** 兼容旧用法：先选设备再连接（一步完成，无「继续连接」等待） */
  async connect(): Promise<DeviceInfo> {
    const usbDevice = await this.requestDeviceOnly();
    return this.connectWithDevice(usbDevice);
  }

  async disconnect(): Promise<void> {
    if (this.device) {
      this.connected = false;
      this.device = null;
    }
  }

  async sendKeyEvent(keyCode: number): Promise<void> {
    await this.execShell(`input keyevent ${keyCode}`);
  }

  async tap(x: number, y: number): Promise<void> {
    await this.execShell(`input tap ${x} ${y}`);
  }

  async inputText(text: string): Promise<void> {
    const escaped = text.replace(/ /g, '%s');
    await this.execShell(`input text "${escaped}"`);
  }

  async scroll(direction: 'up' | 'down' | 'left' | 'right'): Promise<void> {
    if (direction === 'up') {
      await this.execShell(`input swipe 500 1500 500 500 300`);
    } else if (direction === 'down') {
      await this.execShell(`input swipe 500 500 500 1500 300`);
    } else if (direction === 'left') {
      await this.execShell(`input swipe 800 1000 200 1000 300`);
    } else if (direction === 'right') {
      await this.execShell(`input swipe 200 1000 800 1000 300`);
    }
  }

  async terminateApp(packageName: string): Promise<void> {
    await this.execShell(`am force-stop ${packageName}`);
  }

  async getBatteryLevel(): Promise<number> {
    try {
      const output = await this.execShell('dumpsys battery');
      const match = output.match(/level:\s*(\d+)/);
      return match ? parseInt(match[1], 10) : 50;
    } catch (e) { return 50; }
  }

  async getTopActivity(): Promise<AppStackInfo | null> {
    try {
      const output = await this.execShell('dumpsys activity activities | grep -E "mResumedActivity|mFocusedActivity" | tail -n 1');
      const match = output.match(/u0\s+([^\s\/]+)\/([^\s\}]+)/);
      if (match) {
        let pkg = match[1];
        let activity = match[2];
        if (activity.startsWith('.')) activity = pkg + activity;
        return { packageName: pkg, activityName: activity, taskId: 0, isRunning: true };
      }
      return { packageName: 'System', activityName: 'Launcher', taskId: 0, isRunning: true };
    } catch (e) { return null; }
  }

  /**
   * 获取环境信息：设备版本 + 若传入包名则解析该应用的版本号与 SDK 版本。
   */
  async getEnvironment(packageName?: string): Promise<AppEnvInfo | null> {
    try {
      const deviceVer = await this.getProp('ro.build.version.release');
      const deviceSdk = await this.getProp('ro.build.version.sdk');
      const deviceAndroidVersion = deviceVer?.trim() ?? '';
      const deviceSdkVersion = parseInt(deviceSdk?.trim() ?? '0', 10) || 0;

      if (packageName && packageName !== 'com.android.launcher' && packageName !== 'com.android.systemui') {
        const dump = await this.execShell(`dumpsys package ${packageName}`);
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
   * 尝试从当前顶层 Activity 的 dumpsys 输出中解析 WebView/H5 的 URL 与标题。
   * 依赖应用内 WebView 或 Chrome Custom Tab 的 dump 信息，部分应用可能无法获取。
   */
  async getH5Info(packageName?: string): Promise<H5Info | null> {
    try {
      const top = await this.execShell('dumpsys activity top');
      const urlMatch = top.match(/(?:mUrl|url|Uris)=([^\s\)\'"]+)/i) ||
        top.match(/(https?:\/\/[^\s\)\'\"\<\>]+)/);
      const titleMatch = top.match(/(?:title|mTitle)=([^\n]+)/i);
      const currentUrl = urlMatch ? urlMatch[1].trim() : null;
      let pageTitle: string | null = titleMatch ? titleMatch[1].trim() : null;
      if (pageTitle && pageTitle.length > 80) pageTitle = pageTitle.slice(0, 80) + '…';
      const userAgent = await this.getProp('ro.build.version.release').then(
        (v) => `Mozilla/5.0 (Linux; Android ${v}) AppleWebKit/537.36`
      ).catch(() => '');
      return {
        currentUrl: currentUrl || null,
        pageTitle: pageTitle || null,
        userAgent
      };
    } catch (e) {
      return { currentUrl: null, pageTitle: null, userAgent: '' };
    }
  }

  /**
   * 通过 uiautomator dump 获取当前界面层级，解析为 LayoutNode 树。
   * 需要设备支持 uiautomator，部分 ROM 可能无此命令。
   */
  async getLayoutHierarchy(): Promise<LayoutNode | null> {
    try {
      await this.execShell('uiautomator dump /sdcard/window_dump.xml');
      const raw = await this.execShell('cat /sdcard/window_dump.xml');
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

  subscribeLogs(callback: (log: LogEntry) => void): () => void {
    let stopped = false;
    const run = async () => {
        if (!this.device || stopped) return;
        try {
            const proc = await this.device.subprocess.noneProtocol.spawn('logcat -v threadtime *:I');
            const reader = proc.output.getReader();
            const decoder = new TextDecoder();
            while (!stopped) {
                const { value, done } = await reader.read();
                if (done) break;
                const text = decoder.decode(value);
                const lines = text.split('\n');
                lines.forEach(line => {
                    if (line.length < 20) return;
                    const parts = line.split(/\s+/);
                    if (parts.length > 5) {
                        const levelChar = parts[4];
                        if (['V', 'D', 'I', 'W', 'E', 'A', 'F'].includes(levelChar)) {
                            let level = LogLevel.INFO;
                            if (levelChar === 'E' || levelChar === 'F') level = LogLevel.ERROR;
                            if (levelChar === 'W') level = LogLevel.WARN;
                            if (levelChar === 'D') level = LogLevel.DEBUG;
                            callback({
                                timestamp: parts[1] || '',
                                level: level,
                                tag: parts[5]?.replace(':', '') || 'System',
                                message: parts.slice(6).join(' ')
                            });
                        }
                    }
                });
            }
        } catch (e) {
            console.error("Logcat error", e);
        }
    };
    run();
    return () => { stopped = true; };
  }

  private static readonly PNG_HEADER = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  async captureScreen(): Promise<string> {
    if (!this.device) throw new Error("Not connected");
    const CAPTURE_TIMEOUT_MS = 20000;
    const raw = await Promise.race([
      this.device.subprocess.noneProtocol.spawnWait('screencap -p'),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('截图超时，请检查设备或稍后重试')), CAPTURE_TIMEOUT_MS)
      ),
    ]);
    const buf = raw instanceof Uint8Array ? raw : new Uint8Array(raw as ArrayBuffer);
    if (buf.length < 8) throw new Error('截图数据为空或过短');
    let start = 0;
    for (let i = 0; i <= buf.length - AdbService.PNG_HEADER.length; i++) {
      if (buf[i] === 0x89 && buf[i + 1] === 0x50 && buf[i + 2] === 0x4e && buf[i + 3] === 0x47) {
        start = i;
        break;
      }
    }
    const blob = new Blob([new Uint8Array(buf.subarray(start))], { type: 'image/png' });
    return URL.createObjectURL(blob);
  }

  private async execShell(command: string): Promise<string> {
    if (!this.device) return "";
    try {
      return await this.device.subprocess.noneProtocol.spawnWaitText(command);
    } catch (e) {
      return "";
    }
  }

  private async getProp(name: string): Promise<string> {
      const out = await this.execShell(`getprop ${name}`);
      return out.trim();
  }

  async toggleLayoutBounds(): Promise<boolean> {
    const current = await this.getProp('debug.layout');
    const next = current === 'true' ? 'false' : 'true';
    await this.execShell(`setprop debug.layout ${next}`);
    await this.execShell('service call activity 1599295570');
    return next === 'true';
  }

  async toggleShowTaps(): Promise<boolean> {
    const current = await this.execShell('settings get system show_touches');
    const next = current.trim() === '1' ? '0' : '1';
    await this.execShell(`settings put system show_touches ${next}`);
    return next === '1';
  }

  async clearAppData(pkg: string): Promise<void> { await this.execShell(`pm clear ${pkg}`); }
  async restartApp(pkg: string): Promise<void> {
    await this.terminateApp(pkg);
    await this.execShell(`monkey -p ${pkg} -c android.intent.category.LAUNCHER 1`);
  }

  /**
   * 列出应用私有目录下的 databases 与 files（需应用为 debuggable）。
   * 非 debug 包会返回错误提示。
   */
  async listAppDataDir(pkg: string): Promise<string> {
    const out = await this.execShell(`run-as ${pkg} ls -la databases/ 2>&1`);
    if (out.includes('not debuggable') || out.includes('Unknown')) {
      return '当前应用非 debuggable，无法通过 run-as 查看数据目录。';
    }
    if (out.trim().length === 0) return 'databases/ 为空或不存在。';
    return out.trim();
  }

  /**
   * 通过 adb shell atrace 抓取设备端 trace（原始文本）。
   * 时长为秒；categories 如 gfx view am wm。如需可视化 HTML，需在电脑上用 systrace.py 生成后上传。
   */
  async captureAtrace(durationSeconds: number, categories: string[]): Promise<string> {
    if (!this.device) throw new Error("Not connected");
    const cats = categories.length > 0 ? categories.join(' ') : 'gfx view am wm';
    const cmd = `atrace -t ${durationSeconds} ${cats}`;
    const raw = await this.device.subprocess.noneProtocol.spawnWaitText(cmd);
    return typeof raw === 'string' ? raw : '';
  }

  /**
   * 将本地文件推送到设备路径。devicePath 为完整路径，如 /sdcard/Download/xxx.txt。
   * 会先尝试 mkdir -p 父目录。
   */
  async pushFile(file: File, devicePath: string): Promise<void> {
    if (!this.device) throw new Error("Not connected");
    const dir = devicePath.replace(/\/[^/]+$/, '') || '/';
    if (dir !== '/') {
      await this.execShell(`mkdir -p '${dir.replace(/'/g, "'\\''")}'`);
    }
    const sync = await this.device.sync();
    try {
      await sync.write({
        filename: devicePath,
        file: file.stream() as any,
      });
    } finally {
      await sync.dispose();
    }
  }

  /**
   * 从设备拉取文件，返回 Blob。devicePath 为完整路径。
   */
  async pullFile(devicePath: string): Promise<Blob> {
    if (!this.device) throw new Error("Not connected");
    const sync = await this.device.sync();
    try {
      const stream = sync.read(devicePath);
      const chunks: Uint8Array[] = [];
      const reader = stream.getReader();
      try {
        for (;;) {
          const { done, value } = await reader.read();
          if (done) break;
          if (value) chunks.push(value instanceof Uint8Array ? value : new Uint8Array(value));
        }
      } finally {
        reader.releaseLock();
      }
      const total = chunks.reduce((acc, c) => acc + c.length, 0);
      const out = new Uint8Array(total);
      let offset = 0;
      for (const c of chunks) {
        out.set(c, offset);
        offset += c.length;
      }
      return new Blob([out]);
    } finally {
      await sync.dispose();
    }
  }
}

export const adbService = new AdbService();
