import React, { useState, useRef } from 'react';
import { localAdbService as adbService } from '../services/localAdbService';
import { Grid3x3, Fingerprint, Trash2, RotateCcw, Monitor, FileCode, CheckCircle2, Circle, Database, Network, Loader2, Camera, Upload, Download, FolderInput } from 'lucide-react';

const DEFAULT_PUSH_PULL_DIR = '/sdcard/Download';

interface DevToolsProps {
  packageName?: string;
  connected: boolean;
  /** 截屏并返回 blob URL，用于保存到本地 */
  onCaptureScreen?: () => Promise<string | null>;
}

export const DevTools: React.FC<DevToolsProps> = ({ packageName, connected, onCaptureScreen }) => {
  const [layoutBounds, setLayoutBounds] = useState(false);
  const [showTaps, setShowTaps] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);
  const [dbList, setDbList] = useState<string | null>(null);
  const [dbLoading, setDbLoading] = useState(false);
  const [screenshotLoading, setScreenshotLoading] = useState(false);
  const [fileTransferDir, setFileTransferDir] = useState(DEFAULT_PUSH_PULL_DIR);
  const [pushFile, setPushFile] = useState<File | null>(null);
  const [pullPath, setPullPath] = useState('');
  const [pushLoading, setPushLoading] = useState(false);
  const [pullLoading, setPullLoading] = useState(false);
  const [fileTransferMsg, setFileTransferMsg] = useState<string | null>(null);
  const pushInputRef = useRef<HTMLInputElement>(null);

  const isEnabled = connected && !!packageName;
  const displayPackage = packageName || '未选中应用';
  const hasApp = !!packageName;

  const handleListDatabases = async () => {
    if (!isEnabled) return;
    setDbLoading(true);
    setDbList(null);
    try {
      const out = await adbService.listAppDataDir(displayPackage);
      setDbList(out);
    } finally {
      setDbLoading(false);
    }
  };

  const handleToggleLayout = async () => {
    if (!connected) return;
    setProcessing('layout');
    try {
      const newState = await adbService.toggleLayoutBounds();
      setLayoutBounds(newState);
    } finally {
      setProcessing(null);
    }
  };

  const handleToggleTaps = async () => {
    if (!connected) return;
    setProcessing('taps');
    try {
      const newState = await adbService.toggleShowTaps();
      setShowTaps(newState);
    } finally {
      setProcessing(null);
    }
  };

  const handleClearData = async () => {
    if (!isEnabled) return;
    if (!confirm(`确定要清除 ${displayPackage} 的数据吗？`)) return;
    setProcessing('clear');
    try {
      await adbService.clearAppData(displayPackage);
    } finally {
      setProcessing(null);
    }
  };

  const handleRestart = async () => {
    if (!isEnabled) return;
    setProcessing('restart');
    try {
      await adbService.restartApp(displayPackage);
    } finally {
      setProcessing(null);
    }
  };

  const handleScreenshot = async () => {
    if (!connected || !onCaptureScreen) return;
    setScreenshotLoading(true);
    try {
      const url = await onCaptureScreen();
      if (url) {
        const a = document.createElement('a');
        a.download = `screenshot-${Date.now()}.png`;
        a.href = url;
        a.click();
        URL.revokeObjectURL(url);
      }
    } finally {
      setScreenshotLoading(false);
    }
  };

  const handlePush = async () => {
    if (!connected || !pushFile) return;
    setFileTransferMsg(null);
    setPushLoading(true);
    try {
      const base = fileTransferDir.replace(/\/$/, '');
      const devicePath = `${base}/${pushFile.name}`;
      await adbService.pushFile(pushFile, devicePath);
      setFileTransferMsg(`已推送: ${devicePath}`);
      setPushFile(null);
      if (pushInputRef.current) pushInputRef.current.value = '';
    } catch (e) {
      setFileTransferMsg('推送失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPushLoading(false);
    }
  };

  const handlePull = async () => {
    const path = pullPath.trim();
    if (!connected || !path) {
      setFileTransferMsg('请输入设备上的文件路径');
      return;
    }
    setFileTransferMsg(null);
    setPullLoading(true);
    try {
      const blob = await adbService.pullFile(path);
      const name = path.split('/').filter(Boolean).pop() || `pull_${Date.now()}`;
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.download = name;
      a.href = url;
      a.click();
      URL.revokeObjectURL(url);
      setFileTransferMsg(`已拉取: ${path}`);
    } catch (e) {
      setFileTransferMsg('拉取失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setPullLoading(false);
    }
  };

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
      {/* 截屏 */}
      <div className="col-span-1 bg-slate-950/50 rounded-lg p-4 border border-slate-800">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Camera size={14} /> 截屏
        </h4>
        <button
          onClick={handleScreenshot}
          disabled={!connected || screenshotLoading || !onCaptureScreen}
          className="w-full flex items-center justify-center gap-2 p-3 rounded-md border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
        >
          {screenshotLoading ? <Loader2 size={16} className="animate-spin" /> : <Camera size={16} />}
          <span className="text-sm font-medium">{screenshotLoading ? '截屏中...' : '保存截屏'}</span>
        </button>
      </div>

      {/* 文件传输 Push / Pull */}
      <div className="col-span-1 bg-slate-950/50 rounded-lg p-4 border border-slate-800">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Upload size={14} /> 文件传输
        </h4>
        <div className="space-y-3">
          <div>
            <label className="text-[10px] text-slate-500 uppercase tracking-wider flex items-center gap-1 mb-1">
              <FolderInput size={12} /> 默认目录
            </label>
            <input
              type="text"
              value={fileTransferDir}
              onChange={(e) => setFileTransferDir(e.target.value)}
              placeholder={DEFAULT_PUSH_PULL_DIR}
              className="w-full px-3 py-1.5 rounded border border-slate-700 bg-slate-900 text-slate-200 text-xs font-mono placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <input
              ref={pushInputRef}
              type="file"
              className="hidden"
              onChange={(e) => setPushFile(e.target.files?.[0] ?? null)}
            />
            <button
              type="button"
              onClick={() => pushInputRef.current?.click()}
              disabled={!connected}
              className="w-full flex items-center justify-center gap-2 p-2 rounded border border-slate-700 bg-slate-900 text-slate-400 hover:bg-slate-800 hover:text-slate-200 text-xs disabled:opacity-50"
            >
              <Upload size={14} /> {pushFile ? pushFile.name : '选择文件'}
            </button>
            <button
              onClick={handlePush}
              disabled={!connected || !pushFile || pushLoading}
              className="w-full flex items-center justify-center gap-2 p-2 rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {pushLoading ? <Loader2 size={14} className="animate-spin" /> : <Upload size={14} />}
              <span className="text-xs font-medium">{pushLoading ? '推送中...' : '推送到设备'}</span>
            </button>
          </div>
          <div className="flex flex-col gap-1.5">
            <input
              type="text"
              value={pullPath}
              onChange={(e) => { setPullPath(e.target.value); setFileTransferMsg(null); }}
              placeholder={`${fileTransferDir}/文件名`}
              className="w-full px-3 py-1.5 rounded border border-slate-700 bg-slate-900 text-slate-200 text-xs font-mono placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
            <button
              onClick={handlePull}
              disabled={!connected || pullLoading}
              className="w-full flex items-center justify-center gap-2 p-2 rounded border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 disabled:opacity-50"
            >
              {pullLoading ? <Loader2 size={14} className="animate-spin" /> : <Download size={14} />}
              <span className="text-xs font-medium">{pullLoading ? '拉取中...' : '拉取到本机'}</span>
            </button>
          </div>
          {fileTransferMsg && (
            <p className={`text-[10px] font-mono ${fileTransferMsg.startsWith('已') ? 'text-green-400' : 'text-amber-400'}`}>
              {fileTransferMsg}
            </p>
          )}
        </div>
      </div>

      {/* UI Debugging Section */}
      <div className="col-span-1 bg-slate-950/50 rounded-lg p-4 border border-slate-800">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Monitor size={14} /> UI 调试
        </h4>
        <div className="space-y-2">
          <button 
            onClick={handleToggleLayout}
            disabled={!!processing || !connected}
            className={`w-full flex items-center justify-between p-3 rounded-md border transition-all ${
              layoutBounds 
                ? 'bg-cyan-950/30 border-cyan-800 text-cyan-200' 
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <div className="flex items-center gap-3">
              <Grid3x3 size={18} />
              <span className="text-sm font-medium">显示布局边界</span>
            </div>
            {layoutBounds ? <CheckCircle2 size={16} className="text-cyan-400" /> : <Circle size={16} className="opacity-20" />}
          </button>

          <button 
            onClick={handleToggleTaps}
            disabled={!!processing || !connected}
            className={`w-full flex items-center justify-between p-3 rounded-md border transition-all ${
              showTaps 
                ? 'bg-cyan-950/30 border-cyan-800 text-cyan-200' 
                : 'bg-slate-900 border-slate-700 text-slate-400 hover:border-slate-600'
            } disabled:opacity-50 disabled:cursor-not-allowed`}
          >
            <div className="flex items-center gap-3">
              <Fingerprint size={18} />
              <span className="text-sm font-medium">显示触摸反馈</span>
            </div>
            {showTaps ? <CheckCircle2 size={16} className="text-cyan-400" /> : <Circle size={16} className="opacity-20" />}
          </button>
        </div>
      </div>

      {/* App Management Section */}
      <div className="col-span-1 bg-slate-950/50 rounded-lg p-4 border border-slate-800">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <FileCode size={14} /> 应用管理
        </h4>
        <div className="space-y-2">
           <div className={`text-[10px] font-mono mb-2 break-all ${isEnabled ? 'text-slate-600' : 'text-slate-700 italic'}`}>
             {displayPackage}
           </div>
           
           <button 
            onClick={handleRestart}
            disabled={!!processing || !isEnabled}
            className="w-full flex items-center gap-3 p-3 rounded-md border bg-slate-900 border-slate-700 text-slate-300 hover:bg-slate-800 hover:text-white transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <RotateCcw size={18} className={isEnabled ? "text-yellow-500" : "text-slate-600"} />
            <span className="text-sm font-medium">重启应用</span>
          </button>

          <button 
            onClick={handleClearData}
            disabled={!!processing || !isEnabled}
            className="w-full flex items-center gap-3 p-3 rounded-md border bg-slate-900 border-slate-700 text-slate-300 hover:bg-red-950/30 hover:border-red-900 hover:text-red-200 transition-colors disabled:opacity-50 disabled:cursor-not-allowed"
          >
            <Trash2 size={18} className={isEnabled ? "text-red-500" : "text-slate-600"} />
            <span className="text-sm font-medium">清除数据</span>
          </button>
        </div>
      </div>
      
      {/* 应用数据 / 数据库列表 */}
      <div className="col-span-1 bg-slate-950/50 rounded-lg p-4 border border-slate-800">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Database size={14} /> 应用数据目录
        </h4>
        <p className="text-[10px] text-slate-500 mb-2">仅 debuggable 应用可查看 databases/ 列表</p>
        <button
          onClick={handleListDatabases}
          disabled={!!processing || !isEnabled || dbLoading}
          className="w-full flex items-center justify-center gap-2 p-3 rounded-md border border-slate-700 bg-slate-900 text-slate-300 hover:bg-slate-800 transition-colors disabled:opacity-50"
        >
          {dbLoading ? <Loader2 size={16} className="animate-spin" /> : <Database size={16} />}
          <span className="text-sm">{dbLoading ? '获取中...' : '列出 databases'}</span>
        </button>
        {dbList != null && (
          <pre className="mt-3 p-2 bg-slate-950 rounded border border-slate-800 text-[10px] text-slate-400 overflow-auto max-h-32 whitespace-pre-wrap break-all">
            {dbList}
          </pre>
        )}
      </div>

      {/* 网络抓包说明 */}
      <div className="col-span-1 border border-slate-800 rounded-lg p-4 bg-slate-950/50">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Network size={14} /> 网络抓包
        </h4>
        <ul className="text-[10px] text-slate-400 space-y-1 list-disc list-inside">
          <li>系统代理：在电脑端配置 Charles / Proxyman，手机 WiFi 代理指向电脑，可抓 HTTP(S)。</li>
          <li>WebView 调试：Chrome 访问 <code className="bg-slate-800 px-0.5 rounded">chrome://inspect</code>，对 WebView 进行审查与网络面板查看。</li>
          <li>HTTPS 需在设备上安装并信任抓包工具根证书。</li>
        </ul>
      </div>
    </div>
  );
};