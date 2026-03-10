export interface DeviceInfo {
  id: string;
  name: string;
  model: string;
  status: 'connected' | 'disconnected' | 'unauthorized';
  batteryLevel: number;
}

export interface AppStackInfo {
  packageName: string;
  activityName: string;
  taskId: number;
  isRunning: boolean;
}

export interface AppEnvInfo {
  environment: 'PRODUCTION' | 'STAGING' | 'DEVELOPMENT' | 'UNKNOWN';
  versionCode: number;
  versionName: string;
  debuggable: boolean;
  /** 当前应用 targetSdkVersion，仅当有包名时有值 */
  targetSdkVersion?: number;
  /** 当前应用 minSdkVersion，仅当有包名时有值 */
  minSdkVersion?: number;
  /** 设备 Android 系统版本，如 "14" */
  deviceAndroidVersion?: string;
  /** 设备 SDK API Level，如 34 */
  deviceSdkVersion?: number;
}

export interface H5Info {
  currentUrl: string | null;
  pageTitle: string | null;
  userAgent: string;
}

export interface LayoutNode {
  id: string;
  class: string;
  bounds: string; // "[x,y][w,h]"
  children?: LayoutNode[];
}

export enum LogLevel {
  INFO = 'INFO',
  WARN = 'WARN',
  ERROR = 'ERROR',
  DEBUG = 'DEBUG'
}

export interface LogEntry {
  timestamp: string;
  level: LogLevel;
  tag: string;
  message: string;
}

export interface AIAction {
  type: 'click' | 'input' | 'scroll' | 'wait' | 'back' | 'home' | 'finish';
  params?: {
    x?: number;
    y?: number;
    text?: string;
    direction?: 'up' | 'down' | 'left' | 'right';
    duration?: number;
    reason?: string;
  };
}

export interface AutomationStep {
  id: string;
  action: AIAction;
  status: 'pending' | 'running' | 'completed' | 'failed';
  screenshot?: string;
  timestamp: number;
}

/** 反编译结果：从 APK 中解析出的类/方法等信息 */
export interface DecompileInfo {
  /** 包名（从 AndroidManifest 或 classes 推断） */
  packageName: string | null;
  /** 所有类描述符，如 Lcom/example/MainActivity; */
  classes: string[];
  /** 可选：类 -> 方法签名列表（后续扩展） */
  methodsByClass?: Record<string, string[]>;
}
