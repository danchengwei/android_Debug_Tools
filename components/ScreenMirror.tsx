import React, { useEffect, useState, useRef, useCallback } from 'react';
import { localAdbService as adbService } from '../services/localAdbService';
import type { DeviceInfo } from '../types';
import { Smartphone, Loader2, ChevronLeft, Circle, Square, Power, ZoomIn, ZoomOut, Video, StopCircle, RefreshCw } from 'lucide-react';

const MIRROR_WIDTH = 320;
const MIRROR_HEIGHT = 680;

/**
 * ADB 截图兜底模式：两次截图之间至少间隔（毫秒）。
 * 过小会叠请求、延迟飙升；过大则卡顿。全屏 PNG 在本机通常需 80～200ms+。
 */
const ADB_SCREEN_MIN_INTERVAL_MS = 130;

/** Scrcpy 解码：每帧最多连续送入解码器的片数，避免队列堆积导致高延迟 */
const DECODE_BATCH_PER_FRAME = 8;

interface ScreenMirrorProps {
  connected: boolean;
  /** 连接成功后传入，用于标明「画面来自哪台设备」 */
  device: DeviceInfo | null;
}

export const ScreenMirror: React.FC<ScreenMirrorProps> = ({ connected, device }) => {
  const [recording, setRecording] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [isLoadingFrame, setIsLoadingFrame] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [zoom, setZoom] = useState(0.8);
  const [fps, setFps] = useState(0);
  const [connectionStatus, setConnectionStatus] = useState<'connecting' | 'connected' | 'disconnected'>('disconnected');
  /** WebCodecs 解码器已就绪（必须用 state，仅用 ref 不会触发重绘，会一直卡在「正在获取画面」） */
  const [decoderReady, setDecoderReady] = useState(false);
  /** Scrcpy 未就绪时，用 ADB 连续截图（与 WebSocket 并行，连接后立即开始） */
  const [screenshotSrc, setScreenshotSrc] = useState<string | null>(null);
  const [screenshotHint, setScreenshotHint] = useState<string | null>(null);
  /** 手动重连时递增，强制重跑 WebSocket effect */
  const [reconnectKey, setReconnectKey] = useState(0);

  const decoderReadyRef = useRef(false);
  decoderReadyRef.current = decoderReady;
  const screenshotFailCountRef = useRef(0);
  /** 避免 reconnectWebSocket ↔ initWebSocket 循环依赖 */
  const initWebSocketRef = useRef<() => (() => void) | void>(() => {});
  const reconnectWebSocketRef = useRef<() => void>(() => {});

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(Date.now());
  const pendingFramesRef = useRef<VideoFrame[]>([]);
  /** 仅保留「待上屏」的最后一帧，降低 Scrcpy 端到端延迟 */
  const paintRafPendingRef = useRef(false);
  const reconnectTimerRef = useRef<NodeJS.Timeout | null>(null);
  const frameQueueRef = useRef<EncodedVideoChunk[]>([]);
  const isProcessingRef = useRef(false);

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.1, 2));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.1, 0.2));

  // 渲染帧到 Canvas
  const renderFrame = useCallback((frame: VideoFrame) => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    // 调整 canvas 大小以匹配视频帧
    if (canvas.width !== frame.displayWidth || canvas.height !== frame.displayHeight) {
      canvas.width = frame.displayWidth;
      canvas.height = frame.displayHeight;
    }

    ctx.drawImage(frame, 0, 0);
    frame.close();

    // FPS 计算
    frameCountRef.current++;
    const now = Date.now();
    if (now - lastTimeRef.current >= 1000) {
      setFps(frameCountRef.current);
      frameCountRef.current = 0;
      lastTimeRef.current = now;
    }
  }, []);

  // 处理解码后的帧（低延迟：丢弃未上屏旧帧，且同一时刻只排一个 rAF）
  const handleDecodedFrame = useCallback((frame: VideoFrame) => {
    if (document.hidden) {
      frame.close();
      return;
    }
    while (pendingFramesRef.current.length > 0) {
      pendingFramesRef.current.shift()?.close();
    }
    pendingFramesRef.current.push(frame);
    if (paintRafPendingRef.current) return;
    paintRafPendingRef.current = true;
    requestAnimationFrame(() => {
      paintRafPendingRef.current = false;
      const nextFrame = pendingFramesRef.current.shift();
      if (nextFrame) {
        renderFrame(nextFrame);
      }
    });
  }, [renderFrame]);

  // 初始化 WebCodecs 解码器
  const initDecoder = useCallback((width: number, height: number) => {
    if (decoderRef.current) {
      decoderRef.current.close();
    }

    try {
      const decoder = new VideoDecoder({
        output: handleDecodedFrame,
        error: (err) => {
          console.error('解码器错误:', err);
          setScreenError('视频解码失败');
          setConnectionStatus('disconnected');
          setDecoderReady(false);
        }
      });

      decoder.configure({
        codec: 'avc1.64002A',
        codedWidth: width,
        codedHeight: height,
        optimizeForLatency: true,
      });

      decoderRef.current = decoder;
      setDecoderReady(true);
      setIsLoadingFrame(false);
      setConnectionStatus('connected');
    } catch (error) {
      console.error('初始化解码器失败:', error);
      setScreenError('初始化解码器失败');
      setConnectionStatus('disconnected');
      setDecoderReady(false);
    }
  }, [handleDecodedFrame]);

  // 判断是否为关键帧
  function isKeyFrame(data: Uint8Array): boolean {
    for (let i = 0; i < data.length - 4; i++) {
      if (data[i] === 0 && data[i+1] === 0 && data[i+2] === 0 && data[i+3] === 1) {
        const nalType = data[i+4] & 0x1F;
        if (nalType === 5) return true;
      }
    }
    return false;
  }

  // 处理视频数据的解码
  const processVideoData = useCallback((data: Uint8Array) => {
    if (!decoderRef.current || decoderRef.current.state !== 'configured') {
      return;
    }

    try {
      const chunk = new EncodedVideoChunk({
        timestamp: performance.now() * 1000,
        type: isKeyFrame(data) ? 'key' : 'delta',
        data: data
      });

      // 使用队列管理解码，避免解码过载
      frameQueueRef.current.push(chunk);
      
      if (!isProcessingRef.current) {
        isProcessingRef.current = true;
        processFrameQueue();
      }
    } catch (error) {
      console.error('处理视频数据失败:', error);
    }
  }, []);

  // 处理帧队列：每帧批量 decode，减少 WebSocket 堆积造成的延迟
  const processFrameQueue = useCallback(() => {
    const decoder = decoderRef.current;
    if (!decoder || decoder.state !== 'configured') {
      frameQueueRef.current = [];
      isProcessingRef.current = false;
      return;
    }

    let batch = 0;
    while (batch < DECODE_BATCH_PER_FRAME && frameQueueRef.current.length > 0) {
      const chunk = frameQueueRef.current.shift();
      if (chunk) {
        try {
          decoder.decode(chunk);
        } catch (error) {
          console.error('解码失败:', error);
        }
      }
      batch++;
    }

    if (frameQueueRef.current.length > 0) {
      requestAnimationFrame(processFrameQueue);
    } else {
      isProcessingRef.current = false;
    }
  }, []);

  // 重新连接 WebSocket
  const reconnectWebSocket = useCallback(() => {
    if (reconnectTimerRef.current) {
      clearTimeout(reconnectTimerRef.current);
    }

    reconnectTimerRef.current = setTimeout(() => {
      if (connected && autoRefresh) {
        console.log('尝试重新连接 WebSocket...');
        if (wsRef.current) {
          wsRef.current.close();
          wsRef.current = null;
        }
        initWebSocketRef.current();
      }
    }, 3000);
  }, [connected, autoRefresh]);

  // 初始化 WebSocket 连接
  const initWebSocket = useCallback(() => {
    if (!connected || !autoRefresh) return;

    setIsLoadingFrame(true);
    setScreenError(null);
    setConnectionStatus('connecting');
    setDecoderReady(false);

    try {
      // 与页面主机一致，避免用局域网 IP 打开前端时仍连 localhost:13377 连不上 Scrcpy
      const wsHost =
        typeof window !== 'undefined' && window.location.hostname
          ? window.location.hostname
          : '127.0.0.1';
      const ws = new WebSocket(`ws://${wsHost}:13377`);
      wsRef.current = ws;
      ws.binaryType = 'arraybuffer';

      ws.onopen = () => {
        console.log('Scrcpy WebSocket 已连接');
        setConnectionStatus('connecting');
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          try {
            const msg = JSON.parse(event.data);
            
            if (msg.type === 'connected') {
              console.log('Scrcpy 已就绪，分辨率:', msg.width, 'x', msg.height);
              initDecoder(msg.width, msg.height);
            } else if (msg.type === 'fps') {
              setFps(msg.value);
            } else if (msg.type === 'error') {
              setScreenError(msg.message);
              setConnectionStatus('disconnected');
              reconnectWebSocketRef.current();
            }
          } catch (e) {
            console.log('服务器消息:', event.data);
          }
        } else {
          const data = new Uint8Array(event.data);
          processVideoData(data);
        }
      };

      ws.onerror = (err) => {
        console.error('WebSocket 错误:', err);
        setIsLoadingFrame(false);
        if (decoderReadyRef.current) {
          setScreenError('画面流中断，正在重连…');
        } else {
          setScreenError(null);
        }
        setConnectionStatus('disconnected');
        reconnectWebSocketRef.current();
      };

      ws.onclose = () => {
        console.log('WebSocket 已关闭');
        setIsLoadingFrame(false);
        setScreenError(null);
        setConnectionStatus('disconnected');
        reconnectWebSocketRef.current();
      };

      // 定期发送 ping 保持连接
      const pingInterval = setInterval(() => {
        if (ws.readyState === WebSocket.OPEN) {
          ws.send(JSON.stringify({ type: 'ping' }));
        }
      }, 5000);

      return () => {
        clearInterval(pingInterval);
      };
    } catch (error) {
      console.error('初始化 WebSocket 失败:', error);
      setScreenError('连接失败');
      setConnectionStatus('disconnected');
      setIsLoadingFrame(false);
      reconnectWebSocketRef.current();
    }
  }, [connected, autoRefresh, initDecoder, processVideoData]);

  reconnectWebSocketRef.current = reconnectWebSocket;
  initWebSocketRef.current = initWebSocket;

  // Scrcpy WebSocket（与下方 ADB 截图并行；无 WebCodecs 时仅截图）
  useEffect(() => {
    if (!connected || !autoRefresh) {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (decoderRef.current) {
        decoderRef.current.close();
        decoderRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      pendingFramesRef.current.forEach(f => f.close());
      pendingFramesRef.current = [];
      paintRafPendingRef.current = false;
      frameQueueRef.current = [];
      isProcessingRef.current = false;
      if (!connected || !autoRefresh) {
        setDecoderReady(false);
        setConnectionStatus('disconnected');
        setScreenshotHint(null);
        screenshotFailCountRef.current = 0;
      }
      return;
    }

    if (!('VideoDecoder' in window)) {
      return;
    }

    const cleanup = initWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
        wsRef.current = null;
      }
      if (decoderRef.current) {
        decoderRef.current.close();
        decoderRef.current = null;
      }
      if (reconnectTimerRef.current) {
        clearTimeout(reconnectTimerRef.current);
        reconnectTimerRef.current = null;
      }
      pendingFramesRef.current.forEach(f => f.close());
      pendingFramesRef.current = [];
      paintRafPendingRef.current = false;
      frameQueueRef.current = [];
      isProcessingRef.current = false;
      setDecoderReady(false);
      if (cleanup) cleanup();
    };
  }, [connected, autoRefresh, initWebSocket, reconnectKey]);

  /** ADB 连续截图：只要未进入 Scrcpy 解码成功状态就拉流，连接后立刻开始 */
  useEffect(() => {
    if (!connected || !autoRefresh || decoderReady) {
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

    /** 串行截图 + 动态间隔：避免 interval 与慢请求重叠导致越跑越卡 */
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
        setConnectionStatus('connected');
      } catch (e) {
        screenshotFailCountRef.current += 1;
        if (!stopped && screenshotFailCountRef.current >= 2) {
          setScreenshotHint(
            '无法拉取画面：① 确认已 npm start（含 3003 桥接与 scrcpy-server）；② 终端 adb devices 为 device；③ 多机时请在顶栏核对序列号与当前手机一致。'
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
  }, [connected, autoRefresh, decoderReady]);

  const handleManualRefresh = () => {
    setScreenError(null);
    setScreenshotHint(null);
    screenshotFailCountRef.current = 0;
    setDecoderReady(false);
    if (wsRef.current) {
      wsRef.current.close();
      wsRef.current = null;
    }
    if (decoderRef.current) {
      decoderRef.current.close();
      decoderRef.current = null;
    }
    setReconnectKey((k) => k + 1);
  };

  const handleKey = async (code: number) => {
    if (!connected) return;
    await adbService.sendKeyEvent(code);
  };

  // 录屏
  const startRecording = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    
    recordChunksRef.current = [];
    try {
      const stream = canvas.captureStream(60);
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 4000000 });
      mediaRecorderRef.current = recorder;
      
      recorder.ondataavailable = (e) => { if (e.data.size > 0) recordChunksRef.current.push(e.data); };
      
      recorder.onstop = () => {
        const blob = new Blob(recordChunksRef.current, { type: 'video/webm' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.download = `screen-mirror-${new Date().getTime()}.webm`;
        a.href = url;
        a.click();
        URL.revokeObjectURL(url);
        stream.getTracks().forEach((t) => t.stop());
      };
      
      recorder.start(500);
      setRecording(true);
    } catch (e) {
      console.error('录屏启动失败', e);
    }
  };

  const stopRecording = () => {
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setRecording(false);
  };

  return (
    <div className="flex min-h-[26rem] flex-col bg-slate-900 rounded-2xl border border-slate-800/90 shadow-lg shadow-black/20 ring-1 ring-slate-800/50 overflow-hidden xl:max-h-[calc(100vh-5rem)]">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800/50 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Smartphone size={16} className="text-cyan-400" />
          <div className="flex min-w-0 flex-col">
            <span className="text-xs font-medium text-slate-300">屏幕镜像</span>
            {device ? (
              <span
                className="truncate text-[10px] text-slate-500"
                title={`ADB 序列号 ${device.serial}，画面与触控均指向该设备`}
              >
                画面来源：{device.name} · {device.serial}
              </span>
            ) : null}
          </div>
          {decoderReady && (
            <span className="text-[10px] text-cyan-400">Scrcpy · {fps} FPS</span>
          )}
          {!decoderReady && screenshotSrc && (
            <span
              className="max-w-[11rem] truncate text-[10px] text-amber-400/90 sm:max-w-none"
              title="全屏 PNG 经 USB 传输，延迟与帧率远低于 Scrcpy；默认 npm start 已含 13377，若仍为此模式请查 [scrcpy] 日志"
            >
              ADB 截图（约 5～9 帧/秒 · 延迟高）
            </span>
          )}
          {connectionStatus === 'connecting' && !decoderReady && (
            <span className="text-[10px] text-yellow-400">Scrcpy 连接中…</span>
          )}
        </div>
        <div className="flex items-center gap-1">
          <button 
            onClick={() => setAutoRefresh(!autoRefresh)}
            className={`p-1.5 rounded transition-colors ${autoRefresh ? 'bg-cyan-500/20 text-cyan-400' : 'text-slate-400 hover:text-white'}`}
            title={autoRefresh ? '暂停刷新' : '开始刷新'}
          >
            {autoRefresh ? <Circle size={14} className="fill-current" /> : <Square size={14} />}
          </button>
          <button 
            onClick={handleManualRefresh}
            disabled={isLoadingFrame}
            className="p-1.5 text-slate-400 hover:text-white transition-colors disabled:opacity-50"
            title="手动刷新"
          >
            <RefreshCw size={14} className={isLoadingFrame ? 'animate-spin' : ''} />
          </button>
          <button 
            onClick={handleZoomOut}
            className="p-1.5 text-slate-400 hover:text-white transition-colors"
            title="缩小"
          >
            <ZoomOut size={14} />
          </button>
          <span className="text-[10px] text-slate-500 w-8 text-center">{Math.round(zoom * 100)}%</span>
          <button 
            onClick={handleZoomIn}
            className="p-1.5 text-slate-400 hover:text-white transition-colors"
            title="放大"
          >
            <ZoomIn size={14} />
          </button>
          {!recording ? (
            <button 
              onClick={startRecording}
              className="p-1.5 text-red-400 hover:text-red-300 transition-colors"
              title="开始录屏"
            >
              <Video size={14} />
            </button>
          ) : (
            <button 
              onClick={stopRecording}
              className="p-1.5 text-red-400 hover:text-red-300 transition-colors animate-pulse"
              title="停止录屏"
            >
              <StopCircle size={14} />
            </button>
          )}
        </div>
      </div>

      {/* Screen Display */}
      <div className="flex-1 relative bg-slate-950 flex items-center justify-center overflow-hidden">
        {connected ? (
          decoderReady ? (
            <div 
              className="relative transition-transform duration-200"
              style={{ 
                transform: `scale(${zoom})`,
              }}
            >
              <div className="w-[300px] h-[600px] border-4 border-slate-700 rounded-[40px] bg-slate-900 relative overflow-hidden shadow-2xl">
                <div className="w-32 h-6 bg-slate-800 rounded-b-[20px] absolute top-0 left-1/2 transform -translate-x-1/2 flex items-center justify-center z-10">
                  <div className="w-16 h-2 bg-slate-700 rounded-full"></div>
                </div>
                <div className="w-full h-full pt-6 flex items-center justify-center bg-black">
                  <canvas 
                    ref={canvasRef}
                    width={MIRROR_WIDTH}
                    height={MIRROR_HEIGHT}
                    className="max-h-full w-full object-contain"
                    style={{ imageRendering: 'auto' }}
                  />
                </div>
                {recording && (
                  <div className="absolute top-8 right-4 flex items-center gap-1 px-2 py-1 bg-red-500/80 rounded text-white text-[10px] font-bold z-10">
                    <Circle size={8} className="fill-current animate-pulse" />
                    REC
                  </div>
                )}
              </div>
            </div>
          ) : screenshotSrc ? (
              <div 
                className="relative transition-transform duration-200"
                style={{ transform: `scale(${zoom})` }}
              >
                <div className="w-[300px] h-[600px] border-4 border-slate-700 rounded-[40px] bg-slate-900 relative overflow-hidden shadow-2xl">
                  <div className="w-32 h-6 bg-slate-800 rounded-b-[20px] absolute top-0 left-1/2 transform -translate-x-1/2 flex items-center justify-center z-10">
                    <div className="w-16 h-2 bg-slate-700 rounded-full"></div>
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
              <div className="flex flex-col items-center justify-center gap-2 px-4 text-center text-slate-500 max-w-md">
                <Loader2 size={32} className="animate-spin" />
                <span className="text-xs">正在拉取设备画面…</span>
                <span className="text-[10px] text-slate-500 leading-relaxed">
                  <strong className="text-slate-400">默认应走</strong> Scrcpy <strong className="text-slate-400">H.264 视频流</strong>
                  （<code className="text-cyan-600/80">ws://本机:13377</code>）；连上并解码成功后切 Canvas。
                </span>
                <span className="text-[10px] text-slate-600 leading-relaxed">
                  若长期停在本页：请确认已 <code className="text-cyan-600/80">npm start</code>（含 <code className="text-cyan-600/80">scrcpy-server</code>）、本机已安装 scrcpy，并查看终端 <code className="text-cyan-600/80">[scrcpy]</code> 日志。仅当 13377 不可用时才会用{' '}
                  <strong className="text-amber-500/90">ADB 截图</strong>兜底。
                </span>
                {screenshotHint ? (
                  <p className="text-[10px] text-amber-400/90 leading-relaxed mt-1">{screenshotHint}</p>
                ) : null}
              </div>
            )
        ) : (
          <div className="w-[300px] h-[600px] border-4 border-slate-700 rounded-[40px] bg-slate-900 relative shadow-2xl">
            {/* 手机顶部 */}
            <div className="w-32 h-6 bg-slate-800 rounded-b-[20px] absolute top-0 left-1/2 transform -translate-x-1/2 flex items-center justify-center">
              <div className="w-16 h-2 bg-slate-700 rounded-full"></div>
            </div>
            
            {/* 屏幕内容 */}
            <div className="w-full h-full pt-6 flex flex-col items-center justify-center">
              <Smartphone size={48} className="mb-4 opacity-30" />
              <span className="text-sm text-yellow-400">未连接设备</span>
              <span className="text-xs mt-1 text-cyan-400 cursor-pointer" onClick={handleManualRefresh}>
                点击此处刷新重试
              </span>
            </div>
          </div>
        )}
        
        {screenError && (
          <div className="absolute inset-0 flex items-center justify-center bg-slate-950/90">
            <div className="text-center p-4">
              <p className="text-red-400 text-sm mb-2">{screenError}</p>
              <button 
                onClick={handleManualRefresh}
                className="px-3 py-1 bg-slate-800 hover:bg-slate-700 rounded text-xs text-white transition-colors"
              >
                重试
              </button>
            </div>
          </div>
        )}
      </div>

      {/* Control Buttons */}
      <div className="px-3 py-2 bg-slate-800/50 border-t border-slate-800">
        <div className="grid grid-cols-4 gap-2">
          <button 
            onClick={() => handleKey(4)}
            className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300 transition-colors"
          >
            <ChevronLeft size={12} />
            返回
          </button>
          <button 
            onClick={() => handleKey(3)}
            className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300 transition-colors"
          >
            <Circle size={12} />
            主页
          </button>
          <button 
            onClick={() => handleKey(187)}
            className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300 transition-colors"
          >
            <Square size={12} />
            任务
          </button>
          <button 
            onClick={() => handleKey(26)}
            className="flex items-center justify-center gap-1 px-2 py-1.5 bg-slate-800 hover:bg-slate-700 rounded text-xs text-slate-300 transition-colors"
          >
            <Power size={12} />
            电源
          </button>
        </div>
      </div>
    </div>
  );
};
