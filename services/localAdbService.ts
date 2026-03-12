import { DeviceInfo, AppStackInfo, AppEnvInfo, H5Info, LayoutNode, LogEntry, LogLevel } from '../types';

/**
 * 使用本地 ADB 替代 WebUSB
 */
export class LocalAdbService {
  private connected: boolean = false;

  isSupported(): boolean {
    return true; // 本地 ADB 总是支持
  }

  async connect(): Promise<DeviceInfo> {
    try {
      console.log('开始连接本地 ADB...');
      // 检查 ADB 是否可用
      const result = await this.execShell('adb devices');
      console.log('ADB devices 结果:', result);
      
      // 即使没有设备连接，也返回基本的连接状态
      this.connected = true;

      // 尝试获取设备信息，如果失败则使用默认值
      let model = 'Unknown';
      let manufacturer = 'Android';
      let batteryLevel = 50;

      try {
        model = await this.getProp('ro.product.model') || 'Unknown';
        console.log('设备型号:', model);
        manufacturer = await this.getProp('ro.product.manufacturer') || 'Android';
        console.log('设备厂商:', manufacturer);
        batteryLevel = await this.getBatteryLevel();
        console.log('电池电量:', batteryLevel);
      } catch (e) {
        console.error('获取设备信息失败:', e);
      }

      return {
        id: 'local-adb',
        name: `${manufacturer} ${model}`.trim() || 'Android 设备',
        model: model?.trim() || '',
        status: 'connected',
        batteryLevel
      };
    } catch (e: any) {
      console.error('连接失败:', e);
      this.connected = false;
      throw e;
    }
  }

  async disconnect(): Promise<void> {
    this.connected = false;
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

  async getTopActivity(): Promise<AppStackInfo | null> {
    try {
      const output = await this.execShell('adb shell dumpsys activity activities | grep -E "mResumedActivity|mFocusedActivity" | tail -n 1');
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

  async getH5Info(packageName?: string): Promise<H5Info | null> {
    try {
      const top = await this.execShell('adb shell dumpsys activity top');
      const urlMatch = top.match(/(?:mUrl|url|Uris)=([^\s\)\'"]+)/i) ||
        top.match(/(https?:\/\/[^\s\)\'"\<\>]+)/);
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
      // 调用 ADB 服务器的 /api/screen 端点获取截图
      const response = await fetch('http://localhost:3003/api/screen');
      if (!response.ok) {
        throw new Error('截图失败');
      }
      // 直接获取二进制数据并转换为 Blob URL
      const blob = await response.blob();
      return URL.createObjectURL(blob);
    } catch (e) {
      throw new Error('截图失败');
    }
  }

  private async execShell(command: string): Promise<string> {
    return new Promise((resolve, reject) => {
      console.log('执行命令:', command);
      // 浏览器环境中无法直接调用 child_process
      // 需要通过 HTTP 桥接
      fetch(`http://localhost:3003/api/adb?command=${encodeURIComponent(command)}`)
        .then(response => {
          console.log('响应状态:', response.status);
          return response.text();
        })
        .then(data => {
          console.log('响应数据:', data);
          resolve(data);
        })
        .catch(error => {
          console.error('请求失败:', error);
          reject(error);
        });
    });
  }

  private async getProp(name: string): Promise<string> {
      const out = await this.execShell(`adb shell getprop ${name}`);
      return out.trim();
  }
}

export const localAdbService = new LocalAdbService();