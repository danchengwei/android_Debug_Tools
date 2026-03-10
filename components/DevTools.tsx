import React, { useState } from 'react';
import { adbService } from '../services/adbService';
import { Grid3x3, Fingerprint, Trash2, RotateCcw, Monitor, FileCode, CheckCircle2, Circle } from 'lucide-react';

interface DevToolsProps {
  packageName?: string;
  connected: boolean;
}

export const DevTools: React.FC<DevToolsProps> = ({ packageName, connected }) => {
  const [layoutBounds, setLayoutBounds] = useState(false);
  const [showTaps, setShowTaps] = useState(false);
  const [processing, setProcessing] = useState<string | null>(null);

  const isEnabled = connected && !!packageName;
  const displayPackage = packageName || '未选中应用';
  const hasApp = !!packageName;

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

  return (
    <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
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
      
      {/* Placeholder for more tools */}
      <div className="col-span-1 border border-dashed border-slate-800 rounded-lg p-4 flex flex-col items-center justify-center text-slate-600 gap-2">
         <span className="text-xs text-center">更多工具开发中...</span>
         <div className="text-[10px] opacity-50">数据库查看器 • 网络抓包</div>
      </div>

    </div>
  );
};