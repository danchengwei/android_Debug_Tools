import React, { useState, useRef, useEffect } from 'react';
import { chatWithDebugContext, type DebugChatMessage } from '../services/geminiService';
import type { DeviceInfo, AppStackInfo, AppEnvInfo, H5Info, LayoutNode, LogEntry, DecompileInfo } from '../types';
import { MessageSquare, Send, Loader2, X } from 'lucide-react';

export interface AIChatSidebarContext {
  device: DeviceInfo | null;
  stackInfo: AppStackInfo | null;
  envInfo: AppEnvInfo | null;
  h5Info: H5Info | null;
  layout: LayoutNode | null;
  logs: LogEntry[];
  traceContent: string | null;
  decompileInfo: DecompileInfo | null;
}

interface AIChatSidebarProps {
  open: boolean;
  onClose: () => void;
  context: AIChatSidebarContext;
}

function buildSystemContext(ctx: AIChatSidebarContext): string {
  const sections: string[] = [];

  if (ctx.device) {
    const extra = [ctx.device.multiDeviceHint].filter(Boolean).join('\n');
    sections.push(
      `【设备】\n名称: ${ctx.device.name}\n型号: ${ctx.device.model}\nADB 序列号: ${ctx.device.serial}\n状态: ${ctx.device.status}, 电量: ${ctx.device.batteryLevel}%${extra ? `\n${extra}` : ''}`
    );
  } else {
    sections.push('【设备】未连接');
  }

  if (ctx.stackInfo) {
    sections.push(
      `【顶层 Activity】\n包名: ${ctx.stackInfo.packageName}\nActivity: ${ctx.stackInfo.activityName}\n任务 ID: ${ctx.stackInfo.taskId}\n前台: ${ctx.stackInfo.isRunning}${ctx.stackInfo.topActivityRawLine ? `\n原始行: ${ctx.stackInfo.topActivityRawLine}` : ''}`
    );
  } else {
    sections.push('【顶层 Activity】未获取（请点击信息区刷新）');
  }

  if (ctx.envInfo) {
    const env = ctx.envInfo;
    const lines = [
      `环境: ${env.environment}`,
      `versionCode: ${env.versionCode}, versionName: ${env.versionName}`,
      `debuggable: ${env.debuggable}`,
    ];
    if (env.targetSdkVersion != null) lines.push(`targetSdkVersion: ${env.targetSdkVersion}`);
    if (env.minSdkVersion != null) lines.push(`minSdkVersion: ${env.minSdkVersion}`);
    if (env.deviceAndroidVersion != null) lines.push(`设备 Android: ${env.deviceAndroidVersion}`);
    if (env.deviceSdkVersion != null) lines.push(`设备 SDK: ${env.deviceSdkVersion}`);
    sections.push('【环境信息】\n' + lines.join('\n'));
  } else {
    sections.push('【环境信息】未获取（请点击信息区刷新）');
  }

  if (ctx.h5Info) {
    const h5 = ctx.h5Info;
    const cand =
      h5.urlCandidates && h5.urlCandidates.length > 0
        ? `\n候选地址（dumpsys 解析）:\n${h5.urlCandidates.map((u, i) => `  ${i + 1}. ${u}`).join('\n')}`
        : '';
    const wvUa = h5.webViewUserAgent ? `\nWebView UA: ${h5.webViewUserAgent}` : '';
    sections.push(
      `【H5 / WebView】\n主 URL: ${h5.currentUrl ?? '无'}\n标题: ${h5.pageTitle ?? '无'}\nUA: ${h5.userAgent || '无'}${wvUa}${cand}`
    );
  } else {
    sections.push('【H5 / WebView】未获取（请点击信息区刷新）');
  }

  if (ctx.layout) {
    const layoutStr = JSON.stringify(ctx.layout, null, 2);
    sections.push('【布局层级】\n' + (layoutStr.length > 8000 ? layoutStr.slice(0, 8000) + '\n... (已截断)' : layoutStr));
  } else {
    sections.push('【布局层级】未获取（请点击信息区刷新布局）');
  }

  if (ctx.logs.length > 0) {
    const logLines = ctx.logs.slice(0, 50).map((l) => `[${l.level}] ${l.tag}: ${l.message}`);
    sections.push('【最近 logcat】\n' + logLines.join('\n'));
  } else {
    sections.push('【最近 logcat】暂无（连接设备后会持续拉取）');
  }

  if (ctx.traceContent) {
    const excerpt = ctx.traceContent.length > 12000 ? ctx.traceContent.slice(0, 12000) + '\n... (已截断)' : ctx.traceContent;
    sections.push('【Trace / atrace】\n' + excerpt);
  } else {
    sections.push('【Trace / atrace】未抓取（请在 Trace 页抓取或上传）');
  }

  if (ctx.decompileInfo) {
    const d = ctx.decompileInfo;
    const classList = d.classes.length > 400 ? d.classes.slice(0, 400).join('\n') + `\n... 等共 ${d.classes.length} 个类` : d.classes.join('\n');
    sections.push(`【反编译】包名: ${d.packageName ?? '未知'}\n类列表:\n${classList}`);
  } else {
    sections.push('【反编译】未上传 APK（请在反编译页上传）');
  }

  return sections.join('\n\n');
}

export const AIChatSidebar: React.FC<AIChatSidebarProps> = ({ open, onClose, context }) => {
  const [messages, setMessages] = useState<DebugChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [loading, setLoading] = useState(false);
  const listEndRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const handleSend = async () => {
    const text = input.trim();
    if (!text || loading) return;
    setInput('');
    const userMsg: DebugChatMessage = { role: 'user', content: text };
    setMessages((prev) => [...prev, userMsg]);
    setLoading(true);
    try {
      const systemContext = buildSystemContext(context);
      const reply = await chatWithDebugContext(systemContext, text, messages);
      setMessages((prev) => [...prev, { role: 'model', content: reply }]);
    } catch (e) {
      const errMsg = e instanceof Error ? e.message : String(e);
      setMessages((prev) => [...prev, { role: 'model', content: `请求失败: ${errMsg}` }]);
    } finally {
      setLoading(false);
    }
  };

  if (!open) return null;

  return (
    <>
      <div className="fixed inset-0 z-40 bg-black/30" aria-hidden onClick={onClose} />
      <aside
        className="fixed top-0 right-0 z-50 w-full max-w-md h-full bg-slate-900 border-l border-slate-700 shadow-xl flex flex-col"
        role="dialog"
        aria-label="AI 调试对话"
      >
        <div className="flex items-center justify-between px-4 py-3 border-b border-slate-700 bg-slate-850 shrink-0">
          <h2 className="text-sm font-bold text-cyan-300 flex items-center gap-2">
            <MessageSquare size={18} /> AI 调试对话
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="p-1.5 rounded text-slate-400 hover:text-white hover:bg-slate-700 transition-colors"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>
        <p className="text-[10px] text-slate-500 px-4 py-1.5 border-b border-slate-800 shrink-0">
          可访问：设备、Activity 栈、环境、布局、logcat、Trace、反编译等已获取的信息
        </p>
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center text-slate-500 text-sm py-8">
              输入问题开始分析，例如：当前栈顶是哪个 Activity？布局里有多少子节点？根据 logcat 有没有异常？
            </div>
          )}
          {messages.map((msg, i) => (
            <div
              key={i}
              className={`rounded-lg px-3 py-2 text-sm ${
                msg.role === 'user'
                  ? 'ml-8 bg-cyan-900/30 border border-cyan-800/50 text-slate-200'
                  : 'mr-8 bg-slate-800 border border-slate-700 text-slate-300 whitespace-pre-wrap'
              }`}
            >
              {msg.content}
            </div>
          ))}
          {loading && (
            <div className="flex items-center gap-2 text-slate-500 text-sm">
              <Loader2 size={14} className="animate-spin" /> 思考中…
            </div>
          )}
          <div ref={listEndRef} />
        </div>
        <div className="p-3 border-t border-slate-700 bg-slate-850 shrink-0">
          <div className="flex gap-2">
            <textarea
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !e.shiftKey) {
                  e.preventDefault();
                  handleSend();
                }
              }}
              placeholder="输入问题，按 Enter 发送"
              rows={2}
              className="flex-1 resize-none rounded-lg border border-slate-600 bg-slate-800 px-3 py-2 text-sm text-slate-200 placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-cyan-500"
              disabled={loading}
            />
            <button
              type="button"
              onClick={handleSend}
              disabled={!input.trim() || loading}
              className="self-end p-2 rounded-lg bg-cyan-600 text-white hover:bg-cyan-500 disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
              title="发送"
            >
              {loading ? <Loader2 size={18} className="animate-spin" /> : <Send size={18} />}
            </button>
          </div>
        </div>
      </aside>
    </>
  );
};
