import React from 'react';
import { LucideIcon, RefreshCw } from 'lucide-react';

interface InfoPanelProps {
  title: string;
  icon: LucideIcon;
  loading?: boolean;
  children: React.ReactNode;
  action?: React.ReactNode;
  onRefresh?: () => void;
  /** 根容器额外 class，用于栅格内统一高度等 */
  className?: string;
}

export const InfoPanel: React.FC<InfoPanelProps> = ({ title, icon: Icon, loading, children, action, onRefresh, className }) => {
  return (
    <div className={`bg-slate-900/80 rounded-xl border border-slate-800/90 shadow-md shadow-black/20 flex flex-col h-full min-h-0 backdrop-blur-sm ${className ?? ''}`}>
      <div className="flex items-center justify-between px-3 sm:px-4 py-2.5 border-b border-slate-800/90 bg-slate-900/60 shrink-0">
        <h3 className="text-sm font-semibold text-slate-300 flex items-center gap-2">
          <Icon size={16} className="text-cyan-500" />
          {title}
        </h3>
        <div className="flex items-center gap-2">
          {onRefresh && (
            <button 
              onClick={onRefresh} 
              disabled={loading}
              className="p-1 hover:bg-slate-700 rounded text-slate-500 hover:text-cyan-400 transition-colors disabled:opacity-50"
              title="刷新数据"
            >
              <RefreshCw size={14} className={loading ? "animate-spin" : ""} />
            </button>
          )}
          {action && <div>{action}</div>}
        </div>
      </div>
      <div className="p-3 sm:p-4 flex-1 overflow-auto min-h-0">
        {loading ? (
          <div className="h-full flex items-center justify-center">
             <div className="w-4 h-4 border-2 border-slate-600 border-t-cyan-400 rounded-full animate-spin"></div>
          </div>
        ) : (
          children
        )}
      </div>
    </div>
  );
};
