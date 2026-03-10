import React, { useState, useEffect, useCallback } from 'react';
import { Activity, Box, Layers, Globe, Terminal, Cpu, Usb, AlertCircle, RefreshCw, Smartphone, Wrench, HelpCircle, X, ExternalLink, Copy, PlayCircle, Sparkles, Loader2 } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { adbService } from './services/adbService';
import { DeviceInfo, AppStackInfo, AppEnvInfo, H5Info, LogEntry, LayoutNode } from './types';
import { ScreenMirror } from './components/ScreenMirror';
import { InfoPanel } from './components/InfoPanel';
import { DevTools } from './components/DevTools';
import { AIAutomation } from './components/AIAutomation';

const App: React.FC = () => {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [showHelp, setShowHelp] = useState(false);
  const [activeTab, setActiveTab] = useState<'stack' | 'layout' | 'logs' | 'tools' | 'ai'>('stack');
  
  // Connection Error State
  const [connError, setConnError] = useState<{
      code: string;
      message: string;
  } | null>(null);

  // Data States
  const [stackInfo, setStackInfo] = useState<AppStackInfo | null>(null);
  const [envInfo, setEnvInfo] = useState<AppEnvInfo | null>(null);
  const [h5Info, setH5Info] = useState<H5Info | null>(null);
  const [layout, setLayout] = useState<LayoutNode | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingData, setLoadingData] = useState(false);

  const isAppOpen = stackInfo && 
                    stackInfo.packageName !== 'com.android.launcher' && 
                    stackInfo.packageName !== 'com.android.systemui';

  const handleConnect = async () => {
    if (!adbService.isSupported()) {
      setConnError({ code: 'NOT_SUPPORTED', message: "您的浏览器不支持 WebUSB，请使用 Chrome 或 Edge。" });
      return;
    }

    setConnecting(true);
    setConnError(null);
    try {
      const dev = await adbService.connect();
      setDevice(dev);
      fetchDeviceData();
    } catch (err: any) {
      if (err.message === 'CANCELLED') return;
      
      let friendlyMsg = "连接失败，请检查数据线并确保手机已开启 USB 调试。";
      let code = err.name || 'CONNECT_ERROR';

      if (err.message.includes('SecurityError')) {
          friendlyMsg = "权限被拒绝，请在浏览器弹窗中允许访问 USB 设备。";
      } else if (err.message.includes('NetworkError')) {
          friendlyMsg = "设备已被其他程序占用（如本地 ADB 服务），请关闭本地 ADB 后重试。";
      }

      setConnError({ code, message: friendlyMsg });
    } finally {
      setConnecting(false);
    }
  };

  const handleDisconnect = async () => {
    await adbService.disconnect();
    setDevice(null);
    setStackInfo(null);
    setEnvInfo(null);
    setH5Info(null);
    setLogs([]);
  };

  const fetchDeviceData = useCallback(async () => {
    if (!device) return;
    setLoadingData(true);
    try {
        const [stack, env, h5, layoutData] = await Promise.all([
            adbService.getTopActivity(),
            adbService.getEnvironment(),
            adbService.getH5Info(),
            adbService.getLayoutHierarchy()
        ]);
        setStackInfo(stack);
        setEnvInfo(env);
        setH5Info(h5);
        setLayout(layoutData);
    } catch (e) {
        console.error("Error fetching data", e);
    } finally {
        setLoadingData(false);
    }
  }, [device]);

  useEffect(() => {
    if (device) {
      fetchDeviceData();
      const poll = setInterval(fetchDeviceData, 5000);
      const unsubscribe = adbService.subscribeLogs((log) => {
        setLogs(prev => [log, ...prev].slice(0, 100));
      });
      return () => {
        clearInterval(poll);
        unsubscribe();
      };
    }
  }, [device, fetchDeviceData]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col font-sans">
      
      {/* Header */}
      <header className="h-16 bg-slate-900 border-b border-slate-800 flex items-center justify-between px-6 z-10 shrink-0">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded-lg bg-cyan-500/10 flex items-center justify-center border border-cyan-500/20">
            <Cpu size={20} className="text-cyan-400" />
          </div>
          <h1 className="text-lg font-bold tracking-tight text-white">Droid<span className="text-cyan-400">Scope</span></h1>
        </div>

        <div className="flex items-center gap-4">
            {connError && (
                <div className="flex items-center gap-2 text-xs text-red-300 bg-red-950/30 px-3 py-1.5 rounded border border-red-900/40">
                    <AlertCircle size={14} />
                    <span>{connError.message}</span>
                    <button onClick={() => setShowHelp(true)} className="underline ml-1 hover:text-white">查看解决办法</button>
                </div>
            )}

          {device ? (
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              className="flex items-center gap-4 bg-slate-800/50 px-4 py-1.5 rounded-full border border-slate-700"
            >
              <div className="flex flex-col items-end leading-none">
                <span className="text-xs font-medium text-slate-200">{device.name}</span>
                <span className="text-[10px] text-green-400 uppercase tracking-wider">{device.status === 'connected' ? '已连接' : '未连接'}</span>
              </div>
              <button onClick={handleDisconnect} className="p-1 hover:bg-slate-700 rounded-full transition-colors text-slate-400 hover:text-red-400">
                <AlertCircle size={16} />
              </button>
            </motion.div>
          ) : (
            <div className="flex items-center gap-2">
                <button 
                  onClick={handleConnect}
                  disabled={connecting}
                  className="flex items-center gap-2 bg-cyan-600 hover:bg-cyan-500 text-white px-6 py-2 rounded-lg text-sm font-bold transition-all shadow-lg shadow-cyan-900/20 disabled:opacity-50 active:scale-95"
                >
                  {connecting ? <RefreshCw className="animate-spin" size={16} /> : <Usb size={16} />}
                  {connecting ? '正在连接...' : '连接 USB 设备'}
                </button>
            </div>
          )}
        </div>
      </header>

      {/* Error Modal */}
      <AnimatePresence>
        {connError && (
          <div className="fixed inset-0 z-[100] flex items-center justify-center p-4 bg-black/60 backdrop-blur-sm">
            <motion.div 
              initial={{ scale: 0.9, opacity: 0 }}
              animate={{ scale: 1, opacity: 1 }}
              exit={{ scale: 0.9, opacity: 0 }}
              className="bg-slate-900 border border-red-500/30 rounded-xl max-w-md w-full shadow-2xl overflow-hidden"
            >
              <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-red-950/20">
                <h3 className="font-bold text-red-400 flex items-center gap-2">
                  <AlertCircle size={18} /> 
                  连接错误
                </h3>
                <button onClick={() => setConnError(null)} className="text-slate-500 hover:text-white">
                  <X size={20}/>
                </button>
              </div>
              <div className="p-6 space-y-4">
                <div className="p-4 bg-red-500/10 border border-red-500/20 rounded-lg">
                  <p className="text-sm text-red-200 font-medium">{connError.message}</p>
                  <p className="text-[10px] text-red-400/60 mt-2 font-mono break-all">Error Code: {connError.code}</p>
                </div>
                <div className="flex gap-3">
                  <button 
                    onClick={() => setConnError(null)}
                    className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    关闭
                  </button>
                  <button 
                    onClick={() => {
                      setConnError(null);
                      setShowHelp(true);
                    }}
                    className="flex-1 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    查看排查指南
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Connecting Overlay */}
      <AnimatePresence>
        {connecting && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/40 backdrop-blur-[2px]">
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="bg-slate-900/90 border border-slate-700 px-6 py-4 rounded-2xl shadow-2xl flex items-center gap-4"
            >
              <Loader2 className="text-cyan-400 animate-spin" size={24} />
              <div className="flex flex-col">
                <span className="text-white font-bold text-sm">正在连接设备...</span>
                <span className="text-[10px] text-slate-500">请在浏览器弹窗中选择您的安卓设备</span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* Troubleshooting Modal */}
      {showHelp && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/80 backdrop-blur-sm p-4 animate-in fade-in duration-200">
            <div className="bg-slate-900 border border-slate-700 rounded-xl max-w-2xl w-full shadow-2xl overflow-hidden flex flex-col max-h-[90vh]">
                <div className="p-4 border-b border-slate-800 flex justify-between items-center bg-slate-850">
                    <h3 className="font-bold text-white flex items-center gap-2">
                        <HelpCircle size={18} className="text-cyan-400" /> 
                        连接问题排查指南
                    </h3>
                    <button onClick={() => setShowHelp(false)} className="text-slate-500 hover:text-white"><X size={20}/></button>
                </div>
                <div className="p-6 overflow-y-auto space-y-6">
                    
                    <div className="p-4 rounded border bg-slate-950 border-slate-800">
                        <h4 className="text-sm font-bold mb-2 text-slate-300">
                            WebUSB 直连模式说明
                        </h4>
                        <p className="text-xs text-slate-400 leading-relaxed mb-2">
                            1. <span className="text-cyan-400 font-bold">无需本地 ADB：</span>本工具直接通过浏览器 WebUSB API 与手机通信，无需安装任何本地软件。<br/>
                            2. <span className="text-cyan-400 font-bold">浏览器要求：</span>必须使用 Chrome、Edge 或 Opera 浏览器。<br/>
                            3. <span className="text-cyan-400 font-bold">冲突解决：</span>如果连接失败，请确保已关闭电脑上的本地 ADB 服务（执行 <code className="bg-slate-800 px-1 rounded text-cyan-300">adb kill-server</code>），因为 USB 接口无法被同时占用。<br/>
                            4. <span className="text-cyan-400 font-bold">设备授权：</span>点击连接后，请在浏览器弹窗中选择设备，并留意手机屏幕上的“允许 USB 调试”确认弹窗。
                        </p>
                    </div>

                    <div className="p-4 rounded border bg-slate-950 border-slate-800">
                        <h4 className="text-sm font-bold mb-2 text-slate-300">
                            常见问题
                        </h4>
                        <ul className="text-xs text-slate-400 list-disc list-inside space-y-1">
                            <li><span className="text-slate-200">未发现设备：</span>请检查数据线连接，并确保手机已授权调试。</li>
                            <li><span className="text-slate-200">权限不足：</span>在服务器上尝试运行 <span className="text-cyan-400 font-mono">adb devices</span> 确认是否能列出设备。</li>
                            <li><span className="text-slate-200">离线状态：</span>如果设备显示为 offline，请在手机上重新插拔并授权。</li>
                        </ul>
                    </div>
                </div>
                <div className="p-4 border-t border-slate-800 bg-slate-900 flex justify-end">
                    <button onClick={() => setShowHelp(false)} className="px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded text-sm transition-colors">关闭</button>
                </div>
            </div>
        </div>
      )}

      {/* Main Content */}
      <main className="flex-1 p-6 grid grid-cols-1 lg:grid-cols-12 gap-6">
        
        {/* Left Column: Screen Mirror */}
        <div className="lg:col-span-4 flex flex-col min-h-[500px]">
           <ScreenMirror connected={!!device} />
        </div>

        {/* Right Column: Information Grid */}
        <div className="lg:col-span-8 flex flex-col gap-6">
          
          {/* Top Row: Info Panels */}
          <div className="grid grid-cols-1 md:grid-cols-3 gap-6 shrink-0 h-64">
            
            <InfoPanel 
              title="顶层 Activity" 
              icon={Layers} 
              loading={loadingData}
              onRefresh={() => adbService.getTopActivity().then(setStackInfo)}
            >
              {device && !isAppOpen ? (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center px-4">
                    <Layers size={24} className="mb-2 opacity-30" />
                    <span className="text-xs">无 App 打开</span>
                    <span className="text-[10px] mt-1 opacity-50">(当前位于桌面或锁屏)</span>
                </div>
              ) : stackInfo ? (
                <div className="space-y-4">
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">Activity 类名</span>
                    <p className="text-sm font-mono text-cyan-300 break-all">{stackInfo.activityName.split('.').pop()}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">包名</span>
                    <p className="text-xs text-slate-400 break-all">{stackInfo.packageName}</p>
                  </div>
                  <div className="flex gap-2">
                     <span className={`text-[10px] px-2 py-0.5 rounded border ${stackInfo.isRunning ? 'border-green-800 bg-green-900/30 text-green-400' : 'border-red-800 bg-red-900/30 text-red-400'}`}>
                       {stackInfo.isRunning ? '前台运行' : '已暂停'}
                     </span>
                     <span className="text-[10px] px-2 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-400">
                       任务 ID: {stackInfo.taskId}
                     </span>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center px-4">
                    <Layers size={24} className="mb-2 opacity-30" />
                    <span className="text-xs">
                        {device ? "正在获取栈信息..." : "连接设备以查看"}
                    </span>
                </div>
              )}
            </InfoPanel>

            <InfoPanel 
              title="环境信息" 
              icon={Box} 
              loading={loadingData}
              onRefresh={() => adbService.getEnvironment().then(setEnvInfo)}
            >
              {envInfo ? (
                <div className="space-y-4">
                  <div className="flex flex-col items-center justify-center py-2">
                    <span className={`text-xl font-black tracking-widest ${
                      envInfo.environment === 'PRODUCTION' 
                        ? 'text-red-400 drop-shadow-[0_0_8px_rgba(248,113,113,0.3)]' 
                        : envInfo.environment === 'STAGING'
                        ? 'text-yellow-400 drop-shadow-[0_0_8px_rgba(250,204,21,0.3)]'
                        : 'text-green-400'
                    }`}>
                      {envInfo.environment}
                    </span>
                  </div>
                  <div className="grid grid-cols-2 gap-2 text-xs">
                    <div className="bg-slate-950 p-2 rounded border border-slate-800">
                      <span className="block text-[10px] text-slate-500">版本号</span>
                      <span className="text-slate-300 font-mono">{envInfo.versionName}</span>
                    </div>
                    <div className="bg-slate-950 p-2 rounded border border-slate-800">
                      <span className="block text-[10px] text-slate-500">构建号</span>
                      <span className="text-slate-300 font-mono">{envInfo.versionCode}</span>
                    </div>
                  </div>
                </div>
              ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center px-4">
                   <Box size={24} className="mb-2 opacity-30" />
                   <span className="text-xs">
                       {device ? "正在获取属性..." : "连接设备以查看"}
                   </span>
                </div>
              )}
            </InfoPanel>

            <InfoPanel 
              title="WebView H5 调试" 
              icon={Globe} 
              loading={loadingData}
              onRefresh={() => adbService.getH5Info().then(setH5Info)}
            >
               {h5Info && h5Info.currentUrl ? (
                <div className="space-y-3">
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">页面标题</span>
                    <p className="text-sm font-medium text-slate-200 line-clamp-1">{h5Info.pageTitle}</p>
                  </div>
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">当前 URL</span>
                    <div className="p-2 bg-slate-950 rounded border border-slate-800 mt-1">
                      <p className="text-xs font-mono text-cyan-300 break-all line-clamp-3 leading-relaxed">
                        {h5Info.currentUrl}
                      </p>
                    </div>
                  </div>
                  <a 
                    href={h5Info.currentUrl} 
                    target="_blank" 
                    rel="noopener noreferrer"
                    className="text-[10px] text-cyan-500 hover:text-cyan-400 hover:underline flex items-center gap-1 justify-end"
                  >
                    在浏览器中打开 &rarr;
                  </a>
                </div>
               ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center px-4">
                   <Globe size={24} className="mb-2 opacity-30" />
                   <span className="text-xs">未检测到 WebView</span>
                </div>
               )}
            </InfoPanel>

          </div>

          {/* Bottom Row: Tabs (Layout / Logs / Tools) */}
          <div className="h-[600px] bg-slate-900 rounded-xl border border-slate-800 shadow-md flex flex-col">
            <div className="flex border-b border-slate-800 px-2">
              <button 
                onClick={() => setActiveTab('stack')}
                className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'stack' ? 'border-cyan-500 text-cyan-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
              >
                <Layers size={14} /> 布局层级
              </button>
              <button 
                onClick={() => setActiveTab('logs')}
                className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'logs' ? 'border-cyan-500 text-cyan-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
              >
                <Terminal size={14} /> Logcat 日志
              </button>
              <button 
                onClick={() => setActiveTab('tools')}
                className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'tools' ? 'border-cyan-500 text-cyan-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
              >
                <Wrench size={14} /> 工具箱
              </button>
              <button 
                onClick={() => setActiveTab('ai')}
                className={`px-4 py-3 text-xs font-medium border-b-2 transition-colors flex items-center gap-2 ${activeTab === 'ai' ? 'border-cyan-500 text-cyan-400' : 'border-transparent text-slate-500 hover:text-slate-300'}`}
              >
                <Sparkles size={14} /> AI 自动化
              </button>
            </div>

            <div className="flex-1 overflow-auto p-4 font-mono text-xs relative">
               {activeTab === 'ai' && (
                 <AIAutomation connected={!!device} />
               )}

               {activeTab === 'logs' && (
                 <div className="space-y-1">
                   {logs.length === 0 && <span className="text-slate-600 italic">等待日志输入...</span>}
                   {logs.map((log, i) => (
                     <div key={i} className="flex gap-2 hover:bg-slate-800/50 p-0.5 rounded cursor-default">
                       <span className="text-slate-500 shrink-0 select-none">{log.timestamp}</span>
                       <span className={`shrink-0 w-12 font-bold ${
                         log.level === 'ERROR' ? 'text-red-500' : 
                         log.level === 'WARN' ? 'text-yellow-500' : 
                         log.level === 'DEBUG' ? 'text-blue-500' : 'text-slate-400'
                       }`}>{log.level}</span>
                       <span className="text-purple-400 shrink-0 w-32 truncate" title={log.tag}>{log.tag}</span>
                       <span className="text-slate-300">{log.message}</span>
                     </div>
                   ))}
                 </div>
               )}
               
               {activeTab === 'stack' && (
                 <div className="text-slate-300">
                    {layout ? (
                      <pre className="text-xs leading-relaxed text-green-300">
                        {JSON.stringify(layout, null, 2)}
                      </pre>
                    ) : (
                      <div className="flex flex-col items-center justify-center h-32 text-slate-600">
                         <span>
                             {device ? "未捕获到布局层级 (请确保 ADB Agent 已安装)" : "连接设备以查看布局"}
                         </span>
                      </div>
                    )}
                 </div>
               )}

               {activeTab === 'tools' && (
                 <DevTools 
                   packageName={isAppOpen ? stackInfo?.packageName : undefined} 
                   connected={!!device}
                 />
               )}
            </div>
          </div>
        </div>
      </main>
    </div>
  );
};

export default App;