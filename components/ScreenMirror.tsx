import React, { useEffect, useState, useRef, useCallback } from 'react';
import { localAdbService as adbService } from '../services/localAdbService';
import { Smartphone, Loader2, ChevronLeft, Circle, Square, Power, ZoomIn, ZoomOut, Video, StopCircle, RefreshCw } from 'lucide-react';

const MIRROR_WIDTH = 320;
const MIRROR_HEIGHT = 680;

interface ScreenMirrorProps {
  connected: boolean;
}

export const ScreenMirror: React.FC<ScreenMirrorProps> = ({ connected }) => {
  const [recording, setRecording] = useState(false);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [isLoadingFrame, setIsLoadingFrame] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [zoom, setZoom] = useState(0.8);
  const [fps, setFps] = useState(0);
  
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const wsRef = useRef<WebSocket | null>(null);
  const decoderRef = useRef<VideoDecoder | null>(null);
  const frameCountRef = useRef(0);
  const lastTimeRef = useRef(Date.now());
  const pendingFramesRef = useRef<VideoFrame[]>([]);

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

  // 处理解码后的帧
  const handleDecodedFrame = useCallback((frame: VideoFrame) => {
    if (document.hidden) {
      frame.close();
      return;
    }
    
    pendingFramesRef.current.push(frame);
    
    while (pendingFramesRef.current.length > 2) {
      const oldFrame = pendingFramesRef.current.shift();
      oldFrame?.close();
    }
    
    requestAnimationFrame(() => {
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

    const decoder = new VideoDecoder({
      output: handleDecodedFrame,
      error: (err) => {
        console.error('解码器错误:', err);
        setScreenError('视频解码失败');
      }
    });

    decoder.configure({
      codec: 'avc1.64002A',
      codedWidth: width,
      codedHeight: height,
      optimizeForLatency: true,
    });

    decoderRef.current = decoder;
    setIsLoadingFrame(false);
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

  // Scrcpy WebSocket 连接
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
      pendingFramesRef.current.forEach(f => f.close());
      pendingFramesRef.current = [];
      return;
    }

    if (!('VideoDecoder' in window)) {
      setScreenError('浏览器不支持 WebCodecs API');
      return;
    }

    setIsLoadingFrame(true);
    setScreenError(null);

    const ws = new WebSocket('ws://localhost:9999');
    wsRef.current = ws;
    ws.binaryType = 'arraybuffer';

    ws.onopen = () => {
      console.log('Scrcpy WebSocket 已连接');
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
          }
        } catch (e) {
          console.log('服务器消息:', event.data);
        }
      } else {
        if (decoderRef.current && decoderRef.current.state === 'configured') {
          const data = new Uint8Array(event.data);
          
          const chunk = new EncodedVideoChunk({
            timestamp: performance.now() * 1000,
            type: isKeyFrame(data) ? 'key' : 'delta',
            data: data
          });

          try {
            decoderRef.current.decode(chunk);
          } catch (e) {
            console.error('解码失败:', e);
          }
        }
      }
    };

    ws.onerror = (err) => {
      console.error('WebSocket 错误:', err);
      setScreenError('连接失败');
      setIsLoadingFrame(false);
    };

    ws.onclose = () => {
      console.log('WebSocket 已关闭');
      setIsLoadingFrame(false);
    };

    const pingInterval = setInterval(() => {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'ping' }));
      }
    }, 5000);

    return () => {
      clearInterval(pingInterval);
      ws.close();
      if (decoderRef.current) {
        decoderRef.current.close();
        decoderRef.current = null;
      }
      pendingFramesRef.current.forEach(f => f.close());
      pendingFramesRef.current = [];
    };
  }, [connected, autoRefresh, initDecoder]);

  const handleManualRefresh = async () => {
    if (wsRef.current) {
      wsRef.current.close();
    }
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
    <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden">
      {/* Toolbar */}
      <div className="flex items-center justify-between px-3 py-2 bg-slate-800/50 border-b border-slate-800">
        <div className="flex items-center gap-2">
          <Smartphone size={16} className="text-cyan-400" />
          <span className="text-xs font-medium text-slate-300">屏幕镜像</span>
          {connected && decoderRef.current && (
            <span className="text-[10px] text-cyan-400">{fps} FPS</span>
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
          decoderRef.current ? (
            <div 
              className="relative transition-transform duration-200"
              style={{ 
                transform: `scale(${zoom})`,
              }}
            >
              {/* 手机形状容器 */}
              <div className="w-[300px] h-[600px] border-4 border-slate-700 rounded-[40px] bg-slate-900 relative overflow-hidden shadow-2xl">
                {/* 手机顶部 */}
                <div className="w-32 h-6 bg-slate-800 rounded-b-[20px] absolute top-0 left-1/2 transform -translate-x-1/2 flex items-center justify-center">
                  <div className="w-16 h-2 bg-slate-700 rounded-full"></div>
                </div>
                
                {/* 屏幕内容 */}
                <div className="w-full h-full pt-6 flex items-center justify-center">
                  <canvas 
                    ref={canvasRef}
                    width={MIRROR_WIDTH}
                    height={MIRROR_HEIGHT}
                    className="w-full h-full object-cover"
                    style={{ imageRendering: 'auto' }}
                  />
                </div>
                
                {recording && (
                  <div className="absolute top-8 right-4 flex items-center gap-1 px-2 py-1 bg-red-500/80 rounded text-white text-[10px] font-bold">
                    <Circle size={8} className="fill-current animate-pulse" />
                    REC
                  </div>
                )}
              </div>
            </div>
          ) : (
            <div className="flex flex-col items-center justify-center text-slate-500">
              <Loader2 size={32} className="animate-spin mb-2" />
              <span className="text-xs">正在获取屏幕画面...</span>
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
              <span className="text-sm text-yellow-400">Not connected</span>
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
