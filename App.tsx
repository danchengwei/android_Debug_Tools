import React, { useState, useEffect, useCallback } from 'react';
import { Box, Layers, Globe, Terminal, Cpu, Usb, AlertCircle, RefreshCw, Smartphone, Wrench, X, Sparkles, Loader2, FileArchive, Activity, MessageSquare, Link2, LogOut, Copy, Check } from 'lucide-react';
import { motion, AnimatePresence } from 'framer-motion';
import { localAdbService as adbService } from './services/localAdbService';
import { parseSchemeInput } from './services/schemeParse';
import { DeviceInfo, AppStackInfo, AppEnvInfo, H5Info, LogEntry, LayoutNode, DecompileInfo } from './types';
import { ScreenMirror } from './components/ScreenMirror';
import { InfoPanel } from './components/InfoPanel';
import { DevTools } from './components/DevTools';
import { AIAutomation } from './components/AIAutomation';
import { Decompile } from './components/Decompile';
import { Trace } from './components/Trace';
import { AIChatSidebar } from './components/AIChatSidebar';

const App: React.FC = () => {
  const [device, setDevice] = useState<DeviceInfo | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [activeTab, setActiveTab] = useState<'stack' | 'logs' | 'tools' | 'ai' | 'decompile' | 'trace'>('stack');
  /** 已选设备、等待用户在手机上点「允许」后再继续连接 */
  // 移除 WebUSB 相关状态

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
  const [aiSidebarOpen, setAiSidebarOpen] = useState(false);
  const [traceContent, setTraceContent] = useState<string | null>(null);
  const [decompileInfo, setDecompileInfo] = useState<DecompileInfo | null>(null);
  const [schemeUrl, setSchemeUrl] = useState<string>('');
  /** 可选：限定处理 scheme 的目标包名（内部 Deep Link 常用 am start -p） */
  const [schemeTargetPackage, setSchemeTargetPackage] = useState<string>('');
  const [schemeResult, setSchemeResult] = useState<string | null>(null);
  const [schemeTesting, setSchemeTesting] = useState<boolean>(false);
  /** WebView 完整 URL 复制反馈 */
  const [h5UrlCopied, setH5UrlCopied] = useState(false);

  const isAppOpen = stackInfo && 
                    stackInfo.packageName !== 'com.android.launcher' && 
                    stackInfo.packageName !== 'com.android.systemui';

  /** 连接设备 */
  const handleConnect = async () => {
    setConnecting(true);
    setConnError(null);
    try {
      const dev = await adbService.connect();
      setDevice(dev);
      fetchDeviceData();
    } catch (err: unknown) {
      const e = err instanceof Error ? err : new Error(String(err));
      let code = e.name || 'CONNECT_ERROR';
      let msg = e.message || '连接失败';
      // 浏览器对 fetch 失败常统一报 TypeError: Failed to fetch，弹窗再兜底成中文
      if (
        code === 'TypeError' ||
        /failed to fetch|load failed|network request failed|networkerror/i.test(msg)
      ) {
        code = '桥接不可用';
        msg =
          '无法访问本机 ADB 桥接（端口 3003）。请确认：① 已在项目目录执行 npm start（或 npm run dev:bridge / node adb-server.js）；② 终端里出现「ADB server running」；③ 若用手机通过电脑 IP 打开页面，桥接已监听 0.0.0.0，可尝试在电脑浏览器打开同一地址重试。';
      }
      setConnError({ code, message: msg });
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
    setH5UrlCopied(false);
    try {
        const stack = await adbService.getTopActivity();
        setStackInfo(stack);
        const pkg = stack?.packageName;
        const [env, h5, layoutData] = await Promise.all([
            adbService.getEnvironment(pkg),
            adbService.getH5Info(pkg),
            adbService.getLayoutHierarchy()
        ]);
        setEnvInfo(env);
        setH5Info(h5);
        setLayout(layoutData);
    } catch (e) {
        console.error("Error fetching data", e);
    } finally {
        setLoadingData(false);
    }
  }, [device]);

  const copyH5Url = useCallback(async (text: string) => {
    const t = text.trim();
    if (!t) return;
    try {
      await navigator.clipboard.writeText(t);
      setH5UrlCopied(true);
      window.setTimeout(() => setH5UrlCopied(false), 2000);
    } catch {
      try {
        const ta = document.createElement('textarea');
        ta.value = t;
        ta.style.position = 'fixed';
        ta.style.left = '-9999px';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
        setH5UrlCopied(true);
        window.setTimeout(() => setH5UrlCopied(false), 2000);
      } catch {
        /* 忽略 */
      }
    }
  }, []);

  const handleTestScheme = async () => {
    const parsed = parseSchemeInput(schemeUrl);
    if (!parsed.valid) {
      setSchemeResult(parsed.error ?? '解析失败');
      return;
    }
    setSchemeResult(`解析：${parsed.summary ?? ''}\n正在跳转…`);
    setSchemeTesting(true);
    try {
      const pkg = schemeTargetPackage.trim();
      const out = await adbService.openUrl(parsed.normalizedUri, pkg || undefined);
      const tail = out ? String(out).trim() : 'OK';
      setSchemeResult(`解析：${parsed.summary ?? parsed.normalizedUri}\n设备返回：\n${tail}`);
      void fetchDeviceData();
    } catch (e: any) {
      setSchemeResult(`解析：${parsed.summary ?? ''}\n失败：${e?.message || String(e)}`);
    } finally {
      setSchemeTesting(false);
    }
  };

  useEffect(() => {
    if (device) {
      // 仅连接后拉取一次；之后通过各面板的「刷新」按钮手动刷新
      const firstFetchTimer = window.setTimeout(() => fetchDeviceData(), 2000);
      const unsubscribe = adbService.subscribeLogs((log) => {
        setLogs(prev => [log, ...prev].slice(0, 100));
      });
      return () => {
        clearTimeout(firstFetchTimer);
        unsubscribe();
      };
    }
  }, [device, fetchDeviceData]);

  return (
    <div className="min-h-screen bg-slate-950 text-slate-200 flex flex-col font-sans antialiased">
      
      {/* 顶栏：粘性、窄屏换行，错误仅弹窗展示避免重复占高 */}
      <header className="sticky top-0 z-30 shrink-0 border-b border-slate-800/80 bg-slate-950/90 backdrop-blur-md supports-[backdrop-filter]:bg-slate-950/75">
        <div className="mx-auto flex max-w-[1680px] flex-wrap items-center justify-between gap-3 px-4 py-3 sm:px-6 sm:py-3.5">
          <div className="flex min-w-0 items-center gap-2.5 sm:gap-3">
            <div className="flex h-9 w-9 shrink-0 items-center justify-center rounded-xl border border-cyan-500/25 bg-gradient-to-br from-cyan-500/15 to-slate-900">
              <Cpu size={18} className="text-cyan-400" />
            </div>
            <div className="min-w-0">
              <h1 className="truncate text-base font-bold tracking-tight text-white sm:text-lg">
                Droid<span className="text-cyan-400">Scope</span>
              </h1>
              <p className="hidden text-[10px] text-slate-500 sm:block">本地 ADB 调试</p>
            </div>
          </div>

          <div className="flex flex-wrap items-center justify-end gap-2 sm:gap-3">
            <button
              type="button"
              onClick={() => setAiSidebarOpen(true)}
              className="flex items-center gap-1.5 rounded-lg border border-slate-700/90 bg-slate-800/80 px-3 py-2 text-xs font-medium text-slate-200 transition-colors hover:border-slate-600 hover:bg-slate-800 sm:text-sm"
              title="打开 AI 调试对话"
            >
              <MessageSquare size={15} className="shrink-0 text-cyan-400 sm:size-4" />
              AI 对话
            </button>

            {device ? (
              <motion.div
                initial={{ scale: 0.96, opacity: 0 }}
                animate={{ scale: 1, opacity: 1 }}
                className="flex max-w-full items-center gap-2 rounded-full border border-slate-700/80 bg-slate-800/60 py-1 pl-3 pr-1"
              >
                <div className="min-w-0 flex-1 leading-tight">
                  <span
                    className="block max-w-[10rem] truncate text-xs font-medium text-slate-100 sm:max-w-[14rem]"
                    title={device.multiDeviceHint ?? device.serial}
                  >
                    {device.name}
                  </span>
                  <span className="block truncate text-[10px] text-slate-500" title="ADB 序列号：当前所有命令与画面均指向该设备">
                    序列号 {device.serial}
                  </span>
                  <span className="text-[10px] font-medium text-emerald-400/90">
                    {device.status === 'connected' ? '已连接（本机 ADB）' : '未连接'}
                  </span>
                </div>
                <button
                  type="button"
                  onClick={handleDisconnect}
                  className="flex h-8 w-8 shrink-0 items-center justify-center rounded-full text-slate-400 transition-colors hover:bg-red-950/50 hover:text-red-400"
                  title="断开连接"
                >
                  <LogOut size={16} />
                </button>
              </motion.div>
            ) : (
              <button
                type="button"
                onClick={handleConnect}
                disabled={connecting}
                className="flex items-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-semibold text-white shadow-lg shadow-cyan-900/25 transition-all hover:bg-cyan-500 disabled:opacity-50 active:scale-[0.98] sm:px-5"
              >
                {connecting ? <RefreshCw className="size-4 shrink-0 animate-spin" /> : <Usb className="size-4 shrink-0" />}
                {connecting ? '连接中…' : '连接设备'}
              </button>
            )}
          </div>
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
                <div className="flex gap-2">
                  <button
                    onClick={() => { setConnError(null); handleConnect(); }}
                    className="flex-1 px-4 py-2 bg-cyan-600 hover:bg-cyan-500 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    重试连接
                  </button>
                  <button
                    onClick={() => setConnError(null)}
                    className="flex-1 px-4 py-2 bg-slate-800 hover:bg-slate-700 text-white rounded-lg text-sm font-medium transition-colors"
                  >
                    关闭
                  </button>
                </div>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 连接中状态提示 */}
      <AnimatePresence>
        {connecting && (
          <div className="fixed inset-0 z-[110] flex items-center justify-center bg-black/50 backdrop-blur-sm">
            <motion.div 
              initial={{ opacity: 0, y: 10 }}
              animate={{ opacity: 1, y: 0 }}
              exit={{ opacity: 0, y: 10 }}
              className="bg-slate-900/95 border border-cyan-500/30 px-8 py-6 rounded-2xl shadow-2xl flex items-center gap-5 max-w-sm"
            >
              <Loader2 className="text-cyan-400 animate-spin shrink-0" size={28} />
              <div className="flex flex-col gap-1.5">
                <span className="text-white font-bold">正在连接设备</span>
                <span className="text-xs text-slate-400 leading-relaxed">
                  正在通过本地 ADB 连接设备...
                </span>
              </div>
            </motion.div>
          </div>
        )}
      </AnimatePresence>

      {/* 主内容：居中最大宽度 + 大屏双栏（镜像 sticky） */}
      <main className="mx-auto w-full max-w-[1680px] flex-1 px-4 py-4 sm:px-6 sm:py-6">
        <div className="grid grid-cols-1 gap-6 xl:grid-cols-12 xl:gap-8">
          {/* 左侧：屏幕镜像，大屏下随滚动固定 */}
          <aside className="order-1 flex min-h-0 min-w-0 flex-col xl:order-none xl:col-span-4 xl:sticky xl:top-[4.5rem] xl:max-h-[calc(100vh-4.5rem)] xl:self-start xl:overflow-y-auto">
            <ScreenMirror connected={!!device} device={device} />
          </aside>

          {/* 右侧：信息 + Scheme + 工作区 */}
          <div className="order-2 flex min-w-0 flex-col gap-5 xl:col-span-8">
            <section aria-label="设备信息" className="space-y-3">
              <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                <span className="h-px w-6 shrink-0 bg-slate-700" aria-hidden />
                设备信息
                <span className="h-px min-w-[1rem] flex-1 bg-slate-800" aria-hidden />
              </h2>
              <div className="grid grid-cols-1 gap-4 sm:grid-cols-2 sm:gap-5 xl:grid-cols-3">
            <InfoPanel 
              title="顶层 Activity" 
              icon={Layers} 
              loading={loadingData}
              onRefresh={() => fetchDeviceData()}
              className="min-h-[13rem] sm:min-h-[15rem]"
            >
              {!device ? (
                <div className="h-full min-h-[8rem] flex flex-col items-center justify-center text-slate-600 text-center px-4">
                    <Layers size={24} className="mb-2 opacity-30" />
                    <span className="text-xs">连接设备以查看</span>
                </div>
              ) : (
                <div className="space-y-3 max-h-[22rem] overflow-y-auto pr-1">
                  {device && !isAppOpen ? (
                    <div className="flex flex-col items-center justify-center text-slate-600 text-center px-2 py-4">
                        <Layers size={24} className="mb-2 opacity-30" />
                        <span className="text-xs">无 App 打开</span>
                        <span className="text-[10px] mt-1 opacity-50">(当前位于桌面或锁屏)</span>
                    </div>
                  ) : stackInfo ? (
                    <div className="space-y-3">
                      <div>
                        <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">Activity 类名</span>
                        <p className="text-sm font-mono text-cyan-300 break-all">{stackInfo.activityName.split('.').pop()}</p>
                      </div>
                      <div>
                        <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">包名</span>
                        <p className="text-xs text-slate-400 break-all">{stackInfo.packageName}</p>
                      </div>
                      <div className="flex gap-2 flex-wrap">
                         <span className={`text-[10px] px-2 py-0.5 rounded border ${stackInfo.isRunning ? 'border-green-800 bg-green-900/30 text-green-400' : 'border-red-800 bg-red-900/30 text-red-400'}`}>
                           {stackInfo.isRunning ? '前台运行' : '已暂停'}
                         </span>
                         <span className="text-[10px] px-2 py-0.5 rounded border border-slate-700 bg-slate-800 text-slate-400">
                           任务 ID: {stackInfo.taskId}
                         </span>
                      </div>
                      {stackInfo.topActivityRawLine ? (
                        <div className="pt-2 border-t border-slate-800">
                          <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">dumpsys 原始首行</span>
                          <p className="text-[10px] font-mono text-slate-500 break-all mt-1 leading-relaxed" title={stackInfo.topActivityRawLine}>
                            {stackInfo.topActivityRawLine}
                          </p>
                        </div>
                      ) : null}
                    </div>
                  ) : (
                    <div className="flex flex-col items-center justify-center text-slate-600 text-center px-4 py-6">
                        <Layers size={24} className="mb-2 opacity-30" />
                        <span className="text-xs">正在获取栈信息…</span>
                    </div>
                  )}
                </div>
              )}
            </InfoPanel>

            <InfoPanel 
              title="环境信息" 
              icon={Box} 
              loading={loadingData}
              onRefresh={() => fetchDeviceData()}
              className="min-h-[13rem] sm:min-h-[15rem]"
            >
              {envInfo ? (
                <div className="space-y-3">
                  {/* 设备版本：连接后始终显示 */}
                  {(envInfo.deviceAndroidVersion != null || envInfo.deviceSdkVersion != null) && (
                    <div className="pb-2 border-b border-slate-800">
                      <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">设备版本</span>
                      <div className="grid grid-cols-2 gap-1.5 mt-1 text-xs">
                        <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
                          <span className="block text-[10px] text-slate-500">Android</span>
                          <span className="text-slate-300 font-mono">{envInfo.deviceAndroidVersion ?? '-'}</span>
                        </div>
                        <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
                          <span className="block text-[10px] text-slate-500">SDK</span>
                          <span className="text-slate-300 font-mono">{envInfo.deviceSdkVersion ?? '-'}</span>
                        </div>
                      </div>
                    </div>
                  )}
                  {/* 当前应用：仅在有前台应用且非桌面时显示 */}
                  {isAppOpen && (
                    <>
                      <div className="flex flex-col items-center justify-center py-1">
                        <span className={`text-lg font-black tracking-widest ${
                          envInfo.environment === 'PRODUCTION' 
                            ? 'text-red-400' 
                            : envInfo.environment === 'STAGING'
                            ? 'text-yellow-400'
                            : 'text-green-400'
                        }`}>
                          {envInfo.environment}
                        </span>
                        <span className="text-[10px] text-slate-500 mt-0.5">当前应用</span>
                      </div>
                      <div className="grid grid-cols-2 gap-1.5 text-xs">
                        <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
                          <span className="block text-[10px] text-slate-500">应用版本</span>
                          <span className="text-slate-300 font-mono truncate block" title={envInfo.versionName}>{envInfo.versionName}</span>
                        </div>
                        <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
                          <span className="block text-[10px] text-slate-500">构建号</span>
                          <span className="text-slate-300 font-mono">{envInfo.versionCode}</span>
                        </div>
                        {envInfo.targetSdkVersion != null && (
                          <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
                            <span className="block text-[10px] text-slate-500">targetSdk</span>
                            <span className="text-cyan-300 font-mono">{envInfo.targetSdkVersion}</span>
                          </div>
                        )}
                        {envInfo.minSdkVersion != null && (
                          <div className="bg-slate-950 p-1.5 rounded border border-slate-800">
                            <span className="block text-[10px] text-slate-500">minSdk</span>
                            <span className="text-cyan-300 font-mono">{envInfo.minSdkVersion}</span>
                          </div>
                        )}
                      </div>
                    </>
                  )}
                  {!isAppOpen && envInfo.deviceSdkVersion != null && (
                    <div className="text-center text-slate-500 text-xs py-1">无前台应用，仅显示设备版本</div>
                  )}
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
              onRefresh={() => fetchDeviceData()}
              className="min-h-[13rem] sm:min-h-[15rem] sm:col-span-2 xl:col-span-1"
            >
               {h5Info && (h5Info.currentUrl || (h5Info.urlCandidates && h5Info.urlCandidates.length > 0)) ? (
                <div className="space-y-3">
                  <div>
                    <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">页面标题</span>
                    <p className="text-sm font-medium text-slate-200 line-clamp-2" title={h5Info.pageTitle ?? ''}>
                      {h5Info.pageTitle ?? '（无标题）'}
                    </p>
                  </div>
                  <div>
                    <div className="flex items-center justify-between gap-2">
                      <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">
                        完整访问地址
                      </span>
                      <button
                        type="button"
                        onClick={() => copyH5Url(h5Info.currentUrl ?? h5Info.urlCandidates?.[0] ?? '')}
                        className="flex items-center gap-1 rounded border border-slate-700 bg-slate-800/80 px-2 py-1 text-[10px] text-slate-300 transition-colors hover:border-cyan-600/50 hover:text-cyan-300"
                        title="复制完整 URL（含参数）"
                      >
                        {h5UrlCopied ? <Check size={12} className="text-emerald-400" /> : <Copy size={12} />}
                        {h5UrlCopied ? '已复制' : '复制'}
                      </button>
                    </div>
                    <div className="mt-1 max-h-36 overflow-y-auto rounded border border-slate-800 bg-slate-950 p-2">
                      <p className="text-xs font-mono text-cyan-300 break-all leading-relaxed whitespace-pre-wrap select-text">
                        {h5Info.currentUrl ?? h5Info.urlCandidates?.[0]}
                      </p>
                    </div>
                    <p className="mt-1 text-[9px] leading-relaxed text-slate-600">
                      由 <code className="text-slate-500">dumpsys activity</code> / window 多段输出解析，长链接与 query 会尽量保留；若壳包自定义字段不同，可看下方候选列表核对。
                    </p>
                  </div>
                  {h5Info.webViewUserAgent ? (
                    <div>
                      <span className="text-[10px] uppercase text-slate-500 font-bold tracking-wider">WebView UA</span>
                      <p className="mt-1 max-h-20 overflow-y-auto break-all rounded border border-slate-800/80 bg-slate-950/80 p-2 font-mono text-[10px] text-slate-400 select-text">
                        {h5Info.webViewUserAgent}
                      </p>
                    </div>
                  ) : null}
                  {h5Info.urlCandidates && h5Info.urlCandidates.length > 1 ? (
                    <details className="rounded border border-slate-800 bg-slate-950/50 text-left">
                      <summary className="cursor-pointer select-none px-2 py-1.5 text-[10px] font-medium text-slate-400">
                        全部解析地址（共 {h5Info.urlCandidates.length} 条，含主地址）
                      </summary>
                      <ul className="max-h-32 space-y-1 overflow-y-auto border-t border-slate-800 p-2">
                        {h5Info.urlCandidates.map((u, idx) => (
                          <li key={`${idx}-${u.slice(0, 48)}`} className="flex gap-1 text-[10px]">
                            <span className="w-7 shrink-0 text-slate-600">{idx === 0 ? '主' : idx + 1}</span>
                            <button
                              type="button"
                              onClick={() => copyH5Url(u)}
                              className="shrink-0 rounded px-1 text-slate-500 hover:bg-slate-800 hover:text-cyan-400"
                              title="复制完整链接"
                            >
                              <Copy size={10} />
                            </button>
                            <span className="min-w-0 break-all font-mono text-slate-400">{u}</span>
                          </li>
                        ))}
                      </ul>
                    </details>
                  ) : null}
                  {h5Info.currentUrl && /^https?:\/\//i.test(h5Info.currentUrl) ? (
                    <a
                      href={h5Info.currentUrl}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="flex items-center justify-end gap-1 text-[10px] text-cyan-500 hover:text-cyan-400 hover:underline"
                    >
                      在桌面浏览器中打开 &rarr;
                    </a>
                  ) : null}
                  <p className="text-center text-[9px] text-slate-600">
                    测试跳转请用下方「Scheme / Deep Link」。无地址时请点面板右上角刷新或确认前台为含 WebView 的页面。
                  </p>
                </div>
               ) : (
                <div className="h-full flex flex-col items-center justify-center text-slate-600 text-center px-4">
                   <Globe size={24} className="mb-2 opacity-30" />
                   <span className="text-xs">未检测到 WebView / H5 地址</span>
                  <span className="mt-1 text-[10px] text-slate-600">请打开内置网页后点击刷新</span>
                </div>
               )}
            </InfoPanel>
              </div>
            </section>

            <section aria-label="Scheme 跳转测试" className="space-y-3">
              <h2 className="flex items-center gap-2 text-[11px] font-semibold uppercase tracking-[0.12em] text-slate-500">
                <span className="h-px w-6 shrink-0 bg-slate-700" aria-hidden />
                跳转测试
                <span className="h-px min-w-[1rem] flex-1 bg-slate-800" aria-hidden />
              </h2>
              <InfoPanel title="Scheme / Deep Link" icon={Link2} className="shadow-lg shadow-black/15">
                {!device ? (
                  <div className="flex items-center gap-2 py-1 text-xs text-slate-500">
                    <Link2 size={16} className="shrink-0 opacity-40" />
                    请先连接设备后再测试跳转
                  </div>
                ) : (
                  <div className="space-y-3">
                    <p className="text-[10px] leading-relaxed text-slate-500">
                      输入 scheme 或 https，先解析再执行{' '}
                      <code className="rounded bg-slate-950 px-1 py-0.5 text-slate-400">am start -a VIEW -d</code>
                      ；可选包名追加 <code className="rounded bg-slate-950 px-1 py-0.5 text-slate-400">-p</code>。
                    </p>
                    <div className="grid grid-cols-1 gap-3 md:grid-cols-12 md:items-end">
                      <div className="md:col-span-5">
                        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">链接</label>
                        <input
                          value={schemeUrl}
                          onChange={(e) => setSchemeUrl(e.target.value)}
                          placeholder="myapp://detail/1"
                          className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-cyan-300 placeholder:text-slate-600 focus:border-cyan-600/50 focus:outline-none focus:ring-1 focus:ring-cyan-600/30"
                        />
                      </div>
                      <div className="md:col-span-5">
                        <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">限定包名（可选）</label>
                        <input
                          value={schemeTargetPackage}
                          onChange={(e) => setSchemeTargetPackage(e.target.value)}
                          placeholder="com.example.app"
                          className="w-full rounded-lg border border-slate-800 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-300 placeholder:text-slate-600 focus:border-cyan-600/50 focus:outline-none focus:ring-1 focus:ring-cyan-600/30"
                        />
                      </div>
                      <div className="md:col-span-2">
                        <button
                          type="button"
                          onClick={handleTestScheme}
                          disabled={schemeTesting || !schemeUrl.trim()}
                          className={`w-full rounded-lg px-3 py-2 text-sm font-semibold transition-colors md:py-2 ${schemeTesting ? 'bg-slate-700 text-slate-300' : 'bg-cyan-600 text-white hover:bg-cyan-500'}`}
                        >
                          {schemeTesting ? '…' : '跳转'}
                        </button>
                      </div>
                    </div>
                    {schemeResult ? (
                      <div className="max-h-36 overflow-y-auto rounded-lg border border-slate-800 bg-slate-950 p-3 font-mono text-[11px] leading-relaxed text-slate-300 whitespace-pre-wrap break-words">
                        {schemeResult}
                      </div>
                    ) : null}
                  </div>
                )}
              </InfoPanel>
            </section>

            {/* 工作区：布局 / 日志 / 工具等 */}
            <section
              aria-label="调试工作区"
              className="flex min-h-[min(58vh,600px)] flex-col overflow-hidden rounded-2xl border border-slate-800/90 bg-slate-900/60 shadow-lg shadow-black/20 backdrop-blur-sm"
            >
              <div className="tabs-scroll flex shrink-0 gap-0.5 overflow-x-auto border-b border-slate-800/90 bg-slate-900/80 px-1 pt-1 sm:px-2">
              <button 
                type="button"
                onClick={() => setActiveTab('stack')}
                className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 py-2.5 text-xs font-medium transition-colors sm:px-4 ${activeTab === 'stack' ? 'border-b-2 border-cyan-500 bg-slate-800/40 text-cyan-400' : 'border-b-2 border-transparent text-slate-500 hover:bg-slate-800/30 hover:text-slate-300'}`}
              >
                <span className="inline-flex items-center gap-1.5"><Layers size={14} className="shrink-0" /> 布局层级</span>
              </button>
              <button 
                type="button"
                onClick={() => setActiveTab('logs')}
                className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 py-2.5 text-xs font-medium transition-colors sm:px-4 ${activeTab === 'logs' ? 'border-b-2 border-cyan-500 bg-slate-800/40 text-cyan-400' : 'border-b-2 border-transparent text-slate-500 hover:bg-slate-800/30 hover:text-slate-300'}`}
              >
                <span className="inline-flex items-center gap-1.5"><Terminal size={14} className="shrink-0" /> Logcat</span>
              </button>
              <button 
                type="button"
                onClick={() => setActiveTab('tools')}
                className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 py-2.5 text-xs font-medium transition-colors sm:px-4 ${activeTab === 'tools' ? 'border-b-2 border-cyan-500 bg-slate-800/40 text-cyan-400' : 'border-b-2 border-transparent text-slate-500 hover:bg-slate-800/30 hover:text-slate-300'}`}
              >
                <span className="inline-flex items-center gap-1.5"><Wrench size={14} className="shrink-0" /> 工具箱</span>
              </button>
              <button 
                type="button"
                onClick={() => setActiveTab('ai')}
                className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 py-2.5 text-xs font-medium transition-colors sm:px-4 ${activeTab === 'ai' ? 'border-b-2 border-cyan-500 bg-slate-800/40 text-cyan-400' : 'border-b-2 border-transparent text-slate-500 hover:bg-slate-800/30 hover:text-slate-300'}`}
              >
                <span className="inline-flex items-center gap-1.5"><Sparkles size={14} className="shrink-0" /> AI 自动化</span>
              </button>
              <button 
                type="button"
                onClick={() => setActiveTab('decompile')}
                className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 py-2.5 text-xs font-medium transition-colors sm:px-4 ${activeTab === 'decompile' ? 'border-b-2 border-cyan-500 bg-slate-800/40 text-cyan-400' : 'border-b-2 border-transparent text-slate-500 hover:bg-slate-800/30 hover:text-slate-300'}`}
              >
                <span className="inline-flex items-center gap-1.5"><FileArchive size={14} className="shrink-0" /> 反编译</span>
              </button>
              <button 
                type="button"
                onClick={() => setActiveTab('trace')}
                className={`shrink-0 whitespace-nowrap rounded-t-lg px-3 py-2.5 text-xs font-medium transition-colors sm:px-4 ${activeTab === 'trace' ? 'border-b-2 border-cyan-500 bg-slate-800/40 text-cyan-400' : 'border-b-2 border-transparent text-slate-500 hover:bg-slate-800/30 hover:text-slate-300'}`}
              >
                <span className="inline-flex items-center gap-1.5"><Activity size={14} className="shrink-0" /> Trace</span>
              </button>
            </div>

            <div className="min-h-0 flex-1 overflow-auto p-3 font-mono text-xs sm:p-4">
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
                   onCaptureScreen={async () => {
                     try {
                       return await adbService.captureScreen();
                     } catch {
                       return null;
                     }
                   }}
                 />
               )}

               {activeTab === 'decompile' && <Decompile onDecompileInfo={setDecompileInfo} />}

               {activeTab === 'trace' && <Trace connected={!!device} onTraceContent={setTraceContent} />}
            </div>
            </section>
          </div>
        </div>
      </main>

      <AIChatSidebar
        open={aiSidebarOpen}
        onClose={() => setAiSidebarOpen(false)}
        context={{
          device,
          stackInfo,
          envInfo,
          h5Info,
          layout,
          logs,
          traceContent,
          decompileInfo,
        }}
      />
    </div>
  );
};

export default App;