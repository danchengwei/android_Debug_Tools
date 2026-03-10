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
