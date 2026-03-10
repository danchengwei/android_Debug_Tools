import React, { useEffect, useState, useRef } from 'react';
import { adbService } from '../services/adbService';
import { analyzeScreenWithGemini } from '../services/geminiService';
import { Smartphone, Sparkles, Loader2, ChevronLeft, Circle, Square, Power, ZoomIn, ZoomOut, Camera, Video, StopCircle, RefreshCw } from 'lucide-react';

const MIRROR_WIDTH = 320;
const MIRROR_HEIGHT = 680;

interface ScreenMirrorProps {
  connected: boolean;
}

export const ScreenMirror: React.FC<ScreenMirrorProps> = ({ connected }) => {
  const [analyzing, setAnalyzing] = useState(false);
  const [analysisResult, setAnalysisResult] = useState<string | null>(null);
  const [recording, setRecording] = useState(false);
  
  // Screen state
  const [screenImage, setScreenImage] = useState<string | null>(null);
  const [screenError, setScreenError] = useState<string | null>(null);
  const [isLoadingFrame, setIsLoadingFrame] = useState(false);
  const [autoRefresh, setAutoRefresh] = useState(true);
  const [zoom, setZoom] = useState(0.8);
  
  const refreshTimerRef = useRef<number | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const mirrorImgRef = useRef<HTMLImageElement | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordChunksRef = useRef<Blob[]>([]);
  const streamRef = useRef<MediaStream | null>(null);
  const rafIdRef = useRef<number | null>(null);

  const handleZoomIn = () => setZoom(prev => Math.min(prev + 0.1, 2));
  const handleZoomOut = () => setZoom(prev => Math.max(prev - 0.1, 0.2));

  // Effect to fetch initial screen or handle auto-refresh
  useEffect(() => {
    if (connected && autoRefresh) {
        fetchScreen();
        // Use a slower interval for Real ADB as it transfers megabytes of data
        refreshTimerRef.current = window.setInterval(fetchScreen, 3000); 
    } else {
        if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
        if (!connected) setScreenImage(null);
    }
    return () => {
        if (refreshTimerRef.current) clearInterval(refreshTimerRef.current);
    }
  }, [connected, autoRefresh]);

  const fetchScreen = async () => {
      if (!connected) return;
      setScreenError(null);
      try {
          const imgUrl = await adbService.captureScreen();
          setScreenImage(prev => {
              if (prev) URL.revokeObjectURL(prev);
              return imgUrl;
          });
      } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          setScreenError(msg);
          console.error("Failed to fetch screen frame", e);
      }
  };

  const handleManualRefresh = async () => {
      if (isLoadingFrame) return;
      setIsLoadingFrame(true);
      await fetchScreen();
      setIsLoadingFrame(false);
  };

  const handleGeminiAnalyze = async () => {
    if (analyzing || !connected || !screenImage) return;
    setAnalyzing(true);
    setAnalysisResult(null);
    try {
      // Need to convert blob URL back to base64 for Gemini
      const response = await fetch(screenImage);
      const blob = await response.blob();
      const reader = new FileReader();
      reader.onloadend = async () => {
          const base64 = reader.result as string;
          const result = await analyzeScreenWithGemini(base64, "请分析当前界面的 UI/UX 问题，使用中文回复。");
          setAnalysisResult(result || "分析完成。");
          setAnalyzing(false);
      };
      reader.readAsDataURL(blob);
    } catch (error) {
      setAnalysisResult("分析失败，请重试。");
      setAnalyzing(false);
    }
  };

  const handleKey = async (code: number) => {
    if (!connected) return;
    await adbService.sendKeyEvent(code);
    // Delay refresh to allow UI to update on device
    setTimeout(fetchScreen, 500);
  };

  const handleScreenshot = async () => {
    if (!connected || !screenImage) return;
    const link = document.createElement('a');
    link.download = `screenshot-${new Date().getTime()}.png`;
    link.href = screenImage; 
    link.click();
  };

  // 录屏：将当前投屏画面绘制到 canvas，用 MediaRecorder 录制
  const startRecording = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    recordChunksRef.current = [];
    try {
      const stream = canvas.captureStream(15);
      streamRef.current = stream;
      const mime = MediaRecorder.isTypeSupported('video/webm;codecs=vp9')
        ? 'video/webm;codecs=vp9'
        : 'video/webm';
      const recorder = new MediaRecorder(stream, { mimeType: mime, videoBitsPerSecond: 2500000 });
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
    if (rafIdRef.current != null) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
      mediaRecorderRef.current = null;
    }
    setRecording(false);
  };

  // 录屏时的绘制循环：把当前帧画到 canvas
  useEffect(() => {
    if (!recording) return;
    const canvas = canvasRef.current;
    const img = mirrorImgRef.current;
    if (!canvas || !img) return;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const draw = () => {
      if (img.complete && img.naturalWidth > 0) {
        ctx.drawImage(img, 0, 0, MIRROR_WIDTH, MIRROR_HEIGHT);
      } else {
        ctx.fillStyle = '#0f172a';
        ctx.fillRect(0, 0, MIRROR_WIDTH, MIRROR_HEIGHT);
      }
      rafIdRef.current = requestAnimationFrame(draw);
    };
    draw();
    return () => {
      if (rafIdRef.current != null) cancelAnimationFrame(rafIdRef.current);
    };
  }, [recording]);

  return (
    <div className="flex flex-col h-full bg-slate-900 rounded-xl border border-slate-800 overflow-hidden shadow-lg select-none">
      {/* 录屏用：隐藏的 canvas 与镜像图，用于 MediaRecorder 捕获 */}
      <canvas ref={canvasRef} width={MIRROR_WIDTH} height={MIRROR_HEIGHT} className="absolute -left-[9999px] w-0 h-0" />
      <img ref={mirrorImgRef} src={screenImage ?? 'data:image/gif;base64,R0lGOODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw=='} alt="" className="absolute -left-[9999px] w-0 h-0" />
      {/* Top Control Bar */}
      <div className="flex items-center justify-between px-4 py-2 bg-slate-850 border-b border-slate-800 shrink-0">
        <div className="flex items-center gap-2">
           <Smartphone size={16} className="text-cyan-400" />
           <span className="text-xs font-semibold text-slate-300">真机投屏</span>
           <div className="flex items-center gap-1 ml-4 bg-slate-800 rounded px-1 border border-slate-700">
              <button onClick={handleZoomOut} className="p-1 text-slate-400 hover:text-white" title="缩小"><ZoomOut size={12} /></button>
              <span className="text-[10px] text-slate-500 min-w-[30px] text-center font-mono">{Math.round(zoom * 100)}%</span>
              <button onClick={handleZoomIn} className="p-1 text-slate-400 hover:text-white" title="放大"><ZoomIn size={12} /></button>
           </div>
           {connected && (
               <button 
                onClick={() => setAutoRefresh(!autoRefresh)}
                className={`ml-2 text-[10px] px-2 py-0.5 rounded border transition-colors ${autoRefresh ? 'border-green-800 bg-green-900/30 text-green-400' : 'border-slate-700 bg-slate-800 text-slate-400'}`}
               >
                   {autoRefresh ? '自动刷新 (3s)' : '已暂停'}
               </button>
           )}
        </div>
        <div className="flex gap-1 items-center">
            <button 
                onClick={handleGeminiAnalyze}
                disabled={!connected || !screenImage || analyzing}
                className={`flex items-center gap-1.5 px-3 py-1 mr-2 rounded text-[10px] font-bold transition-all ${
                analyzing 
                    ? 'bg-purple-900/50 text-purple-300 cursor-not-allowed' 
                    : connected && screenImage ? 'bg-purple-600 hover:bg-purple-500 text-white shadow shadow-purple-900/20' : 'bg-slate-800 text-slate-500'
                }`}
                title="使用 AI 分析当前界面"
            >
                {analyzing ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                {analyzing ? '分析中' : 'AI 分析'}
            </button>

            <button onClick={handleManualRefresh} disabled={!connected} className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-cyan-400 transition-colors" title="立即刷新">
                <RefreshCw size={16} className={isLoadingFrame ? "animate-spin" : ""} />
            </button>
            <div className="w-px h-4 bg-slate-700 mx-1 self-center"></div>
          <button onClick={handleScreenshot} disabled={!connected || !screenImage} className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-cyan-400 transition-colors" title="保存截图">
            <Camera size={16} />
          </button>
          {!recording ? (
            <button onClick={startRecording} disabled={!connected || !screenImage} className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-red-400 transition-colors" title="开始录屏">
              <Video size={16} />
            </button>
          ) : (
            <button onClick={stopRecording} className="p-1.5 rounded bg-red-600/80 text-white hover:bg-red-500 transition-colors" title="停止录屏">
              <StopCircle size={16} />
            </button>
          )}
          
          <div className="w-px h-4 bg-slate-700 mx-1 self-center"></div>

          <button onClick={() => handleKey(26)} disabled={!connected} className="p-1.5 hover:bg-slate-700 rounded text-slate-400 hover:text-white transition-colors" title="电源键">
            <Power size={16} />
          </button>
        </div>
      </div>

      {/* Screen Container */}
      <div className="relative flex-1 bg-slate-950 flex flex-col items-center justify-center p-4 overflow-auto">
        {!connected ? (
          <div className="text-center text-slate-600 flex flex-col items-center">
            <Smartphone size={32} className="mb-3 opacity-20" />
            <p className="text-xs">等待 USB 连接</p>
          </div>
        ) : (
          <div 
            className="relative transition-transform duration-200 ease-out origin-center"
            style={{ transform: `scale(${zoom})` }}
          >
            <div className="relative w-[320px] h-[680px] bg-black rounded-[48px] border-[12px] border-slate-800 shadow-2xl overflow-hidden flex items-center justify-center ring-1 ring-slate-700">
                {/* Notch */}
                <div className="absolute top-0 left-1/2 -translate-x-1/2 w-32 h-7 bg-slate-800 rounded-b-3xl z-20 flex items-center justify-center">
                    <div className="w-12 h-1 bg-slate-900 rounded-full"></div>
                </div>
                
                {screenError ? (
                    <div className="flex flex-col items-center justify-center text-slate-400 gap-3 p-4 text-center">
                        <span className="text-xs font-mono text-amber-400">{screenError}</span>
                        <span className="text-[10px] text-slate-500">可点击刷新重试</span>
                    </div>
                ) : screenImage ? (
                    <img 
                        src={screenImage} 
                        alt="Screen Mirror" 
                        className="w-full h-full object-cover" 
                    />
                ) : (
                    <div className="flex flex-col items-center justify-center text-slate-600 gap-3">
                        <Loader2 size={24} className="animate-spin text-cyan-500" />
                        <span className="text-xs font-mono text-slate-500">同步画面中...</span>
                    </div>
                )}
            </div>
          </div>
        )}
      </div>

      {/* Basic Navigation */}
      {connected && (
        <div className="h-10 bg-slate-900 flex items-center justify-center gap-8 border-t border-slate-800 shrink-0 z-10">
            <button onClick={() => handleKey(4)} className="p-2 text-slate-500 hover:text-white transition-colors" title="返回">
                <ChevronLeft size={18} />
            </button>
            <button onClick={() => handleKey(3)} className="p-2 text-slate-500 hover:text-white transition-colors" title="主页">
                <Circle size={14} fill="currentColor" className="opacity-50" />
            </button>
            <button onClick={() => handleKey(187)} className="p-2 text-slate-500 hover:text-white transition-colors" title="最近任务">
                <Square size={14} fill="currentColor" className="opacity-50" />
            </button>
        </div>
      )}

      {analysisResult && (
        <div className="p-4 bg-slate-900 border-t border-slate-800 max-h-48 overflow-y-auto absolute bottom-0 w-full z-30 shadow-[0_-10px_40px_rgba(0,0,0,0.5)]">
            <div className="flex justify-between items-center mb-2">
                <h4 className="text-xs font-bold text-purple-400 flex items-center gap-1">
                    <Sparkles size={10} /> Gemini 分析报告
                </h4>
                <button onClick={() => setAnalysisResult(null)} className="text-slate-500 hover:text-white text-xs">关闭</button>
            </div>
            <p className="text-xs text-slate-300 leading-relaxed whitespace-pre-wrap font-mono">
                {analysisResult}
            </p>
        </div>
      )}
    </div>
  );
};