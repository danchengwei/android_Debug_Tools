import React from 'react';
import { LucideIcon, RefreshCw } from 'lucide-react';

interface InfoPanelProps {
  title: string;
  icon: LucideIcon;
  loading?: boolean;
  children: React.ReactNode;
  action?: React.ReactNode;
  onRefresh?: () => void;
}

export const InfoPanel: React.FC<InfoPanelProps> = ({ title, icon: Icon, loading, children, action, onRefresh }) => {
  return (
    <div className="bg-slate-900 rounded-xl border border-slate-800 shadow-md flex flex-col h-full">
      <div className="flex items-center justify-between px-4 py-3 border-b border-slate-800 bg-slate-850/50">
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
      <div className="p-4 flex-1 overflow-auto">
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
