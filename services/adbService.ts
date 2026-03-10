import { Adb, AdbSubprocessService } from '@yume-chan/adb';
import { AdbWebUsbBackend } from '@yume-chan/adb-backend-webusb';
import { DeviceInfo, AppStackInfo, AppEnvInfo, H5Info, LayoutNode, LogEntry, LogLevel } from '../types';

class AdbService {
  private device: any = null;
  private connected: boolean = false;

  isSupported(): boolean {
    return !!(window.navigator && (window.navigator as any).usb);
  }

  async connect(): Promise<DeviceInfo> {
    try {
      // 1. Request USB device
      const usbDevice = await window.navigator.usb.requestDevice({
        filters: [{ classCode: 0xff, subclassCode: 0x42, protocolCode: 1 }]
      });
      
      const backend = new AdbWebUsbBackend(usbDevice);
      const connection = await backend.connect();

      // 2. Connect to ADB
      // Use any to bypass strict type checking for the library's complex API
      const AdbModule = await import('@yume-chan/adb');
      
      this.device = await (AdbModule as any).Adb.authenticate(
          connection,
          {
              async *generateKey() { yield { type: 'rsa', buffer: new Uint8Array() }; },
              async *iterateKeys() { },
              async addKey() { }
          } as any,
          (AdbModule as any).AdbAuthenticator.DEFAULT
      );
      
      this.connected = true;

      // 3. Get basic info
      const model = await this.getProp('ro.product.model');
      const manufacturer = await this.getProp('ro.product.manufacturer');

      return {
        id: usbDevice.serialNumber || "usb-device",
        name: `${manufacturer} ${model}`,
        model: model,
        status: 'connected',
        batteryLevel: await this.getBatteryLevel()
      };
    } catch (e: any) {
      this.connected = false;
      this.device = null;
      throw e;
    }
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

  async getEnvironment(): Promise<AppEnvInfo | null> {
    try {
      const ver = await this.getProp('ro.build.version.release');
      const sdk = await this.getProp('ro.build.version.sdk');
      return {
        environment: 'DEVELOPMENT',
        versionCode: parseInt(sdk.trim()),
        versionName: `Android ${ver.trim()}`,
        debuggable: true
      };
    } catch (e) { return null; }
  }

  async getH5Info(): Promise<H5Info | null> {
    return { currentUrl: null, pageTitle: null, userAgent: "" };
  }

  async getLayoutHierarchy(): Promise<LayoutNode | null> {
    return null;
  }

  subscribeLogs(callback: (log: LogEntry) => void): () => void {
    let stopped = false;
    const run = async () => {
        if (!this.device || stopped) return;
        try {
            const shell = await this.device.subprocess.spawn('logcat -v threadtime *:I');
            const reader = shell.stdout.getReader();
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

  async captureScreen(): Promise<string> {
    if (!this.device) throw new Error("Not connected");
    try {
        const shell = await this.device.subprocess.spawn('screencap -p');
        const chunks: Uint8Array[] = [];
        const reader = shell.stdout.getReader();
        while (true) {
            const { value, done } = await reader.read();
            if (done) break;
            chunks.push(value);
        }
        const blob = new Blob(chunks, { type: 'image/png' });
        return URL.createObjectURL(blob);
    } catch (e) { throw e; }
  }

  private async execShell(command: string): Promise<string> {
    if (!this.device) return "";
    try {
      const shell = await this.device.subprocess.spawn(command);
      const reader = shell.stdout.getReader();
      const decoder = new TextDecoder();
      let output = "";
      while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          output += decoder.decode(value);
      }
      return output;
    } catch (e) { return ""; }
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
}

export const adbService = new AdbService();
