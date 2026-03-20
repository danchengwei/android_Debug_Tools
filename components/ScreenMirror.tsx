import React, { useEffect, useState, useRef } from 'react';
import { localAdbService as adbService } from '../services/localAdbService';
import type { DeviceInfo } from '../types';
import { Smartphone, Loader2, ChevronLeft, Circle, Square, Power, ZoomIn, ZoomOut, RefreshCw, Usb } from 'lucide-react';

/** ADB 截图：两次请求最小间隔（毫秒） */
const ADB_SCREEN_MIN_INTERVAL_MS = 130;
/** 与 scrcpy-server.js 中 HTTP_PORT 一致 */
const SCRCPY_STATUS_PORT = 13377;
/** 探测本机是否已自动拉起 Scrcpy 窗口 */
const NATIVE_SCRCPY_POLL_MS = 4000;

interface ScreenMirrorProps {
  connected: boolean;
  device: DeviceInfo | null;
  /** 未连接时主按钮：发起连接（与顶栏一致） */
  onRequestConnect?: () => void | Promise<void>;
  /** 连接中，用于禁用按钮 */
  connecting?: boolean;
}

export const ScreenMirror: React.FC<ScreenMirrorProps> = ({
  connected,
  device,
  onRequestConnect,
  connecting = false,
}) => {
  const [screenError, setScreenError] = useState<string | null>(null);
  const [isLoadingFrame, setIsLoadingFrame] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [zoom, setZoom] = useState(0.8);
  const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null);
  const [screenshotHint, setScreenshotHint] = useState<string | null>(null);
  /** 本机 scrcpy-server 报告：原生 Scrcpy 子进程是否在跑 */
  const [nativeScrcpyRunning, setNativeScrcpyRunning] = useState(false);
  /** 是否已至少成功请求过一次 13377（避免首屏闪烁文案） */
  const [nativeStatusReady, setNativeStatusReady] = useState(false);
  const screenshotFailCountRef = useRef(0);
  /** 手动刷新时递增，触发重新探测原生 Scrcpy */
  const [statusNonce, setStatusNonce] = useState(0);

  const wsHost =
    typeof window !== 'undefined' && window.location.hostname ? window.location.hostname : '127.0.0.1';

  /** 断开连接后清空画面与状态，回到「未连接」视图 */
  useEffect(() => {
    if (connected) return;
    setScreenError(null);
    setIsLoadingFrame(false);
    setScreenshotHint(null);
    setScreenshotSrc((prev) => {
      if (prev) {
        try {
          URL.revokeObjectURL(prev);
        } catch {
          /* 忽略 */
        }
      }
      return null;
    });
    setZoom(0.8);
    setNativeScrcpyRunning(false);
    setNativeStatusReady(false);
    screenshotFailCountRef.current = 0;
    setStatusNonce((n) => n + 1);
  }, [connected]);

  const handleZoomIn = () => setZoom((prev) => Math.min(prev + 0.1, 2));
  const handleZoomOut = () => setZoom((prev) => Math.max(prev - 0.1, 0.2));

  /** 轮询 scrcpy-server HTTP：真·Scrcpy 由服务端自动 spawn，无需用户手动运行 */
  useEffect(() => {
    if (!connected) {
      setNativeScrcpyRunning(false);
      setNativeStatusReady(false);
      return;
    }
    let stopped = false;
    const poll = async () => {
      try {
        const r = await fetch(`http://${wsHost}:${SCRCPY_STATUS_PORT}/`, { cache: 'no-store' });
        if (!r.ok) throw new Error(String(r.status));
        const j = (await r.json()) as { nativeScrcpyRunning?: boolean };
        if (stopped) return;
        setNativeScrcpyRunning(!!j.nativeScrcpyRunning);
        setNativeStatusReady(true);
      } catch {
        if (!stopped) {
          setNativeScrcpyRunning(false);
          setNativeStatusReady(true);
        }
      }
    };
    void poll();
    const id = window.setInterval(poll, NATIVE_SCRCPY_POLL_MS);
    return () => {
      stopped = true;
      window.clearInterval(id);
    };
  }, [connected, wsHost, statusNonce]);

  /** ADB 连续截图：网页内低帧预览 */
  useEffect(() => {
    if (!connected || !autoRefresh) {
      screenshotFailCountRef.current = 0;
      setScreenshotHint(null);
      setScreenshotSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
      return;
    }

    let stopped = false;
    let timeoutId = 0;
    let inFlight = false;

    const runScreenshotLoop = async () => {
      if (stopped || inFlight) return;
      inFlight = true;
      const started = Date.now();
      try {
        const url = await adbService.captureScreen();
        if (stopped) {
          URL.revokeObjectURL(url);
          return;
        }
        screenshotFailCountRef.current = 0;
        setScreenshotHint(null);
        setScreenshotSrc((prev) => {
          if (prev) URL.revokeObjectURL(prev);
          return url;
        });
        setIsLoadingFrame(false);
      } catch (e) {
        screenshotFailCountRef.current += 1;
        if (!stopped && screenshotFailCountRef.current >= 2) {
          setScreenshotHint(
            '无法拉取画面：① 确认已在电脑上启动本工具且命令行窗口未关；② 手机已开 USB 调试且 adb devices 为 device；③ 多机时核对顶栏序列号。流畅画面请看自动弹出的 Scrcpy 窗口。'
          );
        }
        if (!stopped) setIsLoadingFrame(false);
      } finally {
        inFlight = false;
        if (stopped) return;
        const elapsed = Date.now() - started;
        const wait = Math.max(0, ADB_SCREEN_MIN_INTERVAL_MS - elapsed);
        timeoutId = window.setTimeout(() => void runScreenshotLoop(), wait);
      }
    };

    void runScreenshotLoop();

    return () => {
      stopped = true;
      window.clearTimeout(timeoutId);
      setScreenshotSrc((prev) => {
        if (prev) URL.revokeObjectURL(prev);
        return null;
      });
    };
  }, [connected, autoRefresh]);

  const handleManualRefresh = () => {
    setScreenError(null);
    setScreenshotHint(null);
    screenshotFailCountRef.current = 0;
    setStatusNonce((n) => n + 1);
  };

  const handleKey = async (code: number) => {
    if (!connected) return;
    await adbService.sendKeyEvent(code);
  };

  return (
    <div className="flex min-h-[26rem] flex-col bg-slate-900 rounded-2xl border border-slate-800/90 shadow-lg shadow-black/20 ring-1 ring-slate-800/50 overflow-hidden xl:max-h-[calc(100vh-5rem)]">
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800/50 border-b border-slate-800">
        <div className="flex min-w-0 flex-1 items-center gap-2">
          <Smartphone size={16} className="shrink-0 text-cyan-400" />
          <div className="flex min-w-0 flex-col">
            <span className="text-xs font-medium text-slate-300">屏幕镜像</span>
            {device ? (
              <span
                className="truncate text-[10px] text-slate-500"
                title={`ADB 序列号 ${device.serial}`}
              >
                {device.name} · {device.serial}
              </span>
            ) : null}
          </div>
          {connected && nativeStatusReady && nativeScrcpyRunning ? (
            <span
              className="shrink-0 rounded border border-emerald-500/40 bg-emerald-500/10 px-2 py-0.5 text-[10px] font-semibold text-emerald-400"
              title="本机 Scrcpy 窗口"
            >
              Scrcpy
            </span>
          ) : null}
        </div>
        <div className="flex shrink-0 items-center gap-1">
          <button
            type="button"
            onClick={() => setAutoRefresh(!autoRefresh)}
            disabled={!connected}
            className={`p-1.5 rounded transition-colors disabled:cursor-not-allowed disabled:opacity-30 ${autoRefresh && connected ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-400 hover:text-white'}`}
            title={connected ? (autoRefresh ? '暂停刷新' : '开始刷新') : '请先连接设备'}
          >
            {autoRefresh ? <Circle size={14} className="fill-current" /> : <Square size={14} />}
          </button>
          <button
            type="button"
            onClick={handleManualRefresh}
            disabled={isLoadingFrame || !connected}
            className="p-1.5 text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            title="刷新预览与 Scrcpy 状态"
          >
            <RefreshCw size={14} className={isLoadingFrame ? 'animate-spin' : ''} />
          </button>
          <button
            type="button"
            onClick={handleZoomOut}
            disabled={!connected}
            className="p-1.5 text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            title="缩小"
          >
            <ZoomOut size={14} />
          </button>
          <span className="w-8 text-center text-[10px] text-slate-500">{Math.round(zoom * 100)}%</span>
          <button
            type="button"
            onClick={handleZoomIn}
            disabled={!connected}
            className="p-1.5 text-slate-400 transition-colors hover:text-white disabled:cursor-not-allowed disabled:opacity-30"
            title="放大"
          >
            <ZoomIn size={14} />
          </button>
        </div>
      </div>

      <div className="relative flex flex-1 items-center justify-center overflow-hidden bg-slate-950">
        {connected ? (
          screenshotSrc ? (
            <div className="relative transition-transform duration-200" style={{ transform: `scale(${zoom})` }}>
              <div className="relative h-[600px] w-[300px] overflow-hidden rounded-[40px] border-4 border-slate-700 bg-slate-900 shadow-2xl">
                <div className="absolute left-1/2 top-0 z-10 flex h-6 w-32 -translate-x-1/2 transform items-center justify-center rounded-b-[20px] bg-slate-800">
                  <div className="h-2 w-16 rounded-full bg-slate-700" />
                </div>
                <div className="flex h-full w-full items-center justify-center bg-black pt-6">
                  <img
                    src={screenshotSrc}
                    alt="设备画面"
                    className="max-h-full max-w-full object-contain"
                    draggable={false}
                  />
                </div>
              </div>
            </div>
          ) : (
            <div className="flex max-w-md flex-col items-center justify-center gap-2 px-4 text-center text-slate-500">
              <Loader2 size={28} className="animate-spin" />
              <span className="text-xs">加载预览…</span>
              {screenshotHint ? (
                <p className="text-[10px] text-amber-400/90">{screenshotHint}</p>
              ) : null}
            </div>
          )
        ) : (
          <div className="relative h-[600px] w-[300px] rounded-[40px] border-4 border-dashed border-slate-700/80 bg-slate-950 shadow-2xl">
            <div className="absolute left-1/2 top-0 flex h-6 w-32 -translate-x-1/2 transform items-center justify-center rounded-b-[20px] bg-slate-800/80">
              <div className="h-2 w-16 rounded-full bg-slate-700" />
            </div>
            <div className="flex h-full w-full flex-col items-center justify-center gap-4 px-5 pt-8 text-center">
              <Usb size={36} className="text-slate-600" aria-hidden />
              <p className="text-sm text-slate-400">未连接</p>
              {onRequestConnect ? (
                <button
                  type="button"
                  onClick={() => void onRequestConnect()}
                  disabled={connecting}
                  className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white transition-colors hover:bg-cyan-500 disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {connecting ? (
                    <Loader2 size={16} className="animate-spin" />
                  ) : (
                    <Usb size={16} />
                  )}
                  {connecting ? '连接中…' : '连接设备'}
                </button>
              ) : null}
            </div>
          </div>
        )}

        {screenError ? (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/90">
            <div className="p-4 text-center">
              <p className="mb-2 text-sm text-red-400">{screenError}</p>
              <button
                type="button"
                onClick={handleManualRefresh}
                className="rounded bg-slate-800 px-3 py-1 text-xs text-white transition-colors hover:bg-slate-700"
              >
                重试
              </button>
            </div>
          </div>
        ) : null}
      </div>

      <div
        className={`border-t border-slate-800 bg-slate-800/50 px-3 py-2 ${!connected ? 'opacity-40' : ''}`}
        aria-disabled={!connected}
      >
        <div className="grid grid-cols-4 gap-2">
          <button
            type="button"
            onClick={() => handleKey(4)}
            disabled={!connected}
            className="flex items-center justify-center gap-1 rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:hover:bg-slate-800"
          >
            <ChevronLeft size={12} />
            返回
          </button>
          <button
            type="button"
            onClick={() => handleKey(3)}
            disabled={!connected}
            className="flex items-center justify-center gap-1 rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:hover:bg-slate-800"
          >
            <Circle size={12} />
            主页
          </button>
          <button
            type="button"
            onClick={() => handleKey(187)}
            disabled={!connected}
            className="flex items-center justify-center gap-1 rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:hover:bg-slate-800"
          >
            <Square size={12} />
            任务
          </button>
          <button
            type="button"
            onClick={() => handleKey(26)}
            disabled={!connected}
            className="flex items-center justify-center gap-1 rounded bg-slate-800 px-2 py-1.5 text-xs text-slate-300 transition-colors hover:bg-slate-700 disabled:cursor-not-allowed disabled:hover:bg-slate-800"
          >
            <Power size={12} />
            电源
          </button>
        </div>
      </div>
    </div>
  );
};
