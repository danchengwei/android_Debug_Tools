import React, { useState } from 'react';
import { adbService } from '../services/adbService';
import { analyzeTraceWithGemini } from '../services/geminiService';
import { Activity, Upload, FileText, Sparkles, Loader2, Download, ChevronDown } from 'lucide-react';

const DEFAULT_CATEGORIES = ['gfx', 'view', 'am', 'wm'];
const ALL_CATEGORIES = ['gfx', 'view', 'am', 'wm', 'sched', 'binder_driver', 'input', 'dalvik', 'app', 'res', 'disk', 'sync', 'workq', 'memreclaim', 'freq', 'idle', 'power'];

export const Trace: React.FC<{ connected: boolean }> = ({ connected }) => {
  const [duration, setDuration] = useState(10);
  const [categories, setCategories] = useState<string[]>(DEFAULT_CATEGORIES);
  const [capturing, setCapturing] = useState(false);
  const [atraceRaw, setAtraceRaw] = useState<string | null>(null);
  const [traceHtmlUrl, setTraceHtmlUrl] = useState<string | null>(null);
  const [aiResult, setAiResult] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);
  const [showCats, setShowCats] = useState(false);

  const toggleCat = (cat: string) => {
    setCategories((prev) =>
      prev.includes(cat) ? prev.filter((c) => c !== cat) : [...prev, cat]
    );
  };

  const handleCapture = async () => {
    if (!connected || capturing || duration < 1 || duration > 120) return;
    setCapturing(true);
    setAtraceRaw(null);
    setAiResult(null);
    try {
      const raw = await adbService.captureAtrace(duration, categories);
      setAtraceRaw(raw);
    } catch (e) {
      console.error(e);
      setAtraceRaw('抓取失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setCapturing(false);
    }
  };

  const handleDownloadAtrace = () => {
    if (!atraceRaw) return;
    const blob = new Blob([atraceRaw], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `atrace_${duration}s_${Date.now()}.txt`;
    a.click();
    URL.revokeObjectURL(url);
  };

  const handleUploadHtml = (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file || !file.name.toLowerCase().endsWith('.html')) return;
    if (traceHtmlUrl) URL.revokeObjectURL(traceHtmlUrl);
    setTraceHtmlUrl(URL.createObjectURL(file));
    setAiResult(null);
  };

  const handleAiAnalyze = async () => {
    const content = atraceRaw?.trim();
    if (!content || content.startsWith('抓取失败')) return;
    setAiLoading(true);
    setAiResult(null);
    try {
      const result = await analyzeTraceWithGemini(content);
      setAiResult(result);
    } catch (e) {
      setAiResult('分析失败: ' + (e instanceof Error ? e.message : String(e)));
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full gap-4 overflow-auto">
      {/* 设备抓取 atrace */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Activity size={14} /> 设备抓取 Trace（atrace）
        </h4>
        <p className="text-[10px] text-slate-500 mb-3">
          在设备上执行 atrace 抓取原始数据，可下载为 .txt。若要得到可视化 HTML，请在电脑上使用 systrace.py 生成后上传下方「上传 Trace HTML」。
        </p>
        <div className="flex flex-wrap items-center gap-3">
          <label className="flex items-center gap-2 text-xs text-slate-400">
            时长(秒)
            <input
              type="number"
              min={1}
              max={120}
              value={duration}
              onChange={(e) => setDuration(Number(e.target.value) || 10)}
              className="w-14 px-2 py-1 rounded border border-slate-700 bg-slate-900 text-slate-200 text-xs"
            />
          </label>
          <div className="relative">
            <button
              type="button"
              onClick={() => setShowCats(!showCats)}
              className="flex items-center gap-1 px-3 py-1.5 rounded border border-slate-700 bg-slate-900 text-slate-300 text-xs"
            >
              标签 ({categories.length}) <ChevronDown size={12} />
            </button>
            {showCats && (
              <div className="absolute top-full left-0 mt-1 p-2 rounded border border-slate-700 bg-slate-900 z-10 max-h-40 overflow-y-auto flex flex-wrap gap-1">
                {ALL_CATEGORIES.map((c) => (
                  <label key={c} className="flex items-center gap-1 text-[10px] text-slate-400 cursor-pointer">
                    <input
                      type="checkbox"
                      checked={categories.includes(c)}
                      onChange={() => toggleCat(c)}
                      className="rounded"
                    />
                    {c}
                  </label>
                ))}
              </div>
            )}
          </div>
          <button
            onClick={handleCapture}
            disabled={!connected || capturing}
            className="flex items-center gap-2 px-4 py-2 rounded-lg bg-cyan-600 hover:bg-cyan-500 text-white text-xs font-medium disabled:opacity-50"
          >
            {capturing ? (
              <>
                <Loader2 size={14} className="animate-spin" />
                抓取中 {duration}s…
              </>
            ) : (
              <>开始抓取</>
            )}
          </button>
        </div>
        {atraceRaw !== null && (
          <div className="mt-3 flex flex-wrap gap-2">
            <button
              onClick={handleDownloadAtrace}
              className="flex items-center gap-1.5 px-3 py-1.5 rounded border border-slate-600 bg-slate-800 text-slate-300 text-xs hover:bg-slate-700"
            >
              <Download size={12} /> 下载 atrace.txt
            </button>
            {!atraceRaw.startsWith('抓取失败') && (
              <button
                onClick={handleAiAnalyze}
                disabled={aiLoading}
                className="flex items-center gap-1.5 px-3 py-1.5 rounded bg-purple-600 text-white text-xs hover:bg-purple-500 disabled:opacity-50"
              >
                {aiLoading ? <Loader2 size={12} className="animate-spin" /> : <Sparkles size={12} />}
                AI 分析
              </button>
            )}
          </div>
        )}
      </div>

      {/* systrace.py 命令说明 */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
          <FileText size={14} /> 在电脑上生成 Trace HTML（systrace.py）
        </h4>
        <p className="text-[10px] text-slate-500 mb-2">
          格式：<code className="bg-slate-800 px-1 rounded text-cyan-300">python $ANDROID_HOME/platform-tools/systrace/systrace.py [标签] -t 时长 -o 输出.html</code>
        </p>
        <pre className="text-[10px] text-slate-400 bg-slate-900 rounded p-3 overflow-x-auto whitespace-pre-wrap">
{`# 示例：抓取 10 秒，包含 gfx/view/am/wm
python $ANDROID_HOME/platform-tools/systrace/systrace.py gfx view am wm -t 10 -o ~/Desktop/app_trace.html`}
        </pre>
      </div>

      {/* 上传 Trace HTML */}
      <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
        <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-3 flex items-center gap-2">
          <Upload size={14} /> 上传 Trace HTML
        </h4>
        <label className="inline-flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-600 bg-slate-800 text-slate-300 text-xs cursor-pointer hover:bg-slate-700">
          <Upload size={14} />
          选择 .html 文件
          <input type="file" accept=".html" onChange={handleUploadHtml} className="hidden" />
        </label>
        {traceHtmlUrl && (
          <div className="mt-3 rounded border border-slate-700 overflow-hidden bg-white">
            <iframe
              title="Trace 预览"
              src={traceHtmlUrl}
              className="w-full h-[400px] min-h-[300px]"
              sandbox="allow-scripts allow-same-origin"
            />
          </div>
        )}
      </div>

      {/* AI 分析结果 */}
      {aiResult && (
        <div className="rounded-lg border border-slate-800 bg-slate-950/50 p-4">
          <h4 className="text-xs font-bold text-slate-500 uppercase tracking-wider mb-2 flex items-center gap-2">
            <Sparkles size={14} /> AI 分析结果
          </h4>
          <div className="text-xs text-slate-300 whitespace-pre-wrap leading-relaxed">{aiResult}</div>
        </div>
      )}
    </div>
  );
};
