import React, { useState, useMemo } from 'react';
import { decompileApk } from '../services/decompileService';
import { analyzeDecompiledWithGemini } from '../services/geminiService';
import { DecompileInfo } from '../types';
import { FileArchive, Search, Sparkles, Loader2, X, Send } from 'lucide-react';

export const Decompile: React.FC<{
  /** 同步反编译结果给 AI 对话侧边栏 */
  onDecompileInfo?: (info: DecompileInfo | null) => void;
}> = ({ onDecompileInfo }) => {
  const [info, setInfo] = useState<DecompileInfo | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [searchKeyword, setSearchKeyword] = useState('');
  const [aiQuestion, setAiQuestion] = useState('');
  const [aiAnswer, setAiAnswer] = useState<string | null>(null);
  const [aiLoading, setAiLoading] = useState(false);

  const handleFileChange = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    e.target.value = '';
    if (!file) return;
    if (!file.name.toLowerCase().endsWith('.apk')) {
      setError('请选择 .apk 文件');
      return;
    }
    setError(null);
    setInfo(null);
    setAiAnswer(null);
    onDecompileInfo?.(null);
    setLoading(true);
    try {
      const result = await decompileApk(file);
      setInfo(result);
      onDecompileInfo?.(result);
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : '解析 APK 失败');
    } finally {
      setLoading(false);
    }
  };

  const filteredClasses = useMemo(() => {
    if (!info?.classes) return [];
    const kw = searchKeyword.trim().toLowerCase();
    if (!kw) return info.classes;
    return info.classes.filter((c) => c.toLowerCase().includes(kw));
  }, [info?.classes, searchKeyword]);

  const handleAiAnalyze = async () => {
    const q = aiQuestion.trim();
    if (!q || !info?.classes?.length) return;
    setAiLoading(true);
    setAiAnswer(null);
    try {
      const answer = await analyzeDecompiledWithGemini(info.classes, q);
      setAiAnswer(answer);
    } catch (err: unknown) {
      setAiAnswer(err instanceof Error ? err.message : '大模型分析失败');
    } finally {
      setAiLoading(false);
    }
  };

  return (
    <div className="flex flex-col h-full gap-4">
      {/* 上传区域 */}
      <div className="flex flex-wrap items-center gap-3">
        <label className="flex items-center gap-2 px-4 py-2 rounded-lg border border-slate-600 bg-slate-800 text-slate-200 hover:bg-slate-700 cursor-pointer transition-colors">
          <FileArchive size={18} />
          <span className="text-sm font-medium">上传 APK 反编译</span>
          <input
            type="file"
            accept=".apk"
            className="hidden"
            onChange={handleFileChange}
            disabled={loading}
          />
        </label>
        {loading && (
          <span className="flex items-center gap-2 text-slate-400 text-sm">
            <Loader2 size={16} className="animate-spin" /> 解析中…
          </span>
        )}
        {info && (
          <span className="text-xs text-cyan-400 font-mono">
            共 {info.classes.length} 个类
            {info.packageName != null && ` · ${info.packageName}`}
          </span>
        )}
      </div>

      {error && (
        <div className="flex items-center justify-between px-4 py-2 rounded-lg bg-red-950/40 border border-red-800 text-red-300 text-sm">
          {error}
          <button type="button" onClick={() => setError(null)} className="p-1 hover:text-white">
            <X size={14} />
          </button>
        </div>
      )}

      {info && (
        <>
          {/* 搜索 */}
          <div className="flex items-center gap-2">
            <Search size={16} className="text-slate-500 shrink-0" />
            <input
              type="text"
              placeholder="搜索类名，如 com.、Activity、Fragment"
              value={searchKeyword}
              onChange={(e) => setSearchKeyword(e.target.value)}
              className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-200 placeholder-slate-500 text-sm focus:outline-none focus:ring-1 focus:ring-cyan-500"
            />
            <span className="text-xs text-slate-500 shrink-0">
              匹配 {filteredClasses.length} / {info.classes.length}
            </span>
          </div>

          {/* 类列表 */}
          <div className="flex-1 min-h-0 rounded-lg border border-slate-800 bg-slate-950 overflow-hidden flex flex-col">
            <div className="px-3 py-2 border-b border-slate-800 text-xs text-slate-500 font-medium">
              类列表（DEX 描述符）
            </div>
            <div className="flex-1 overflow-auto p-2 font-mono text-xs">
              {filteredClasses.length === 0 ? (
                <div className="text-slate-500 py-4 text-center">
                  {searchKeyword.trim() ? '无匹配类' : '暂无类数据'}
                </div>
              ) : (
                <ul className="space-y-0.5">
                  {filteredClasses.map((cls, i) => (
                    <li key={`${cls}-${i}`} className="text-slate-400 hover:text-cyan-300 break-all">
                      {cls}
                    </li>
                  ))}
                </ul>
              )}
            </div>
          </div>

          {/* 大模型分析 */}
          <div className="rounded-lg border border-slate-800 bg-slate-950 overflow-hidden">
            <div className="px-3 py-2 border-b border-slate-800 flex items-center gap-2 text-xs font-medium text-slate-400">
              <Sparkles size={14} className="text-purple-400" />
              大模型分析（例如：当前反编译是否使用了 xxx 类？）
            </div>
            <div className="p-3 space-y-2">
              <div className="flex gap-2">
                <input
                  type="text"
                  placeholder="输入问题，如：是否使用了 OkHttp？是否包含 ReactNative？"
                  value={aiQuestion}
                  onChange={(e) => setAiQuestion(e.target.value)}
                  onKeyDown={(e) => e.key === 'Enter' && handleAiAnalyze()}
                  className="flex-1 min-w-0 px-3 py-2 rounded-lg border border-slate-700 bg-slate-900 text-slate-200 placeholder-slate-500 text-sm focus:outline-none focus:ring-1 focus:ring-purple-500"
                />
                <button
                  type="button"
                  onClick={handleAiAnalyze}
                  disabled={aiLoading || !info.classes.length}
                  className="flex items-center gap-2 px-4 py-2 rounded-lg bg-purple-600 hover:bg-purple-500 text-white text-sm font-medium disabled:opacity-50 disabled:cursor-not-allowed"
                >
                  {aiLoading ? <Loader2 size={16} className="animate-spin" /> : <Send size={16} />}
                  分析
                </button>
              </div>
              {aiAnswer != null && (
                <div className="p-3 rounded-lg bg-slate-900 border border-slate-800 text-sm text-slate-300 whitespace-pre-wrap">
                  {aiAnswer}
                </div>
              )}
            </div>
          </div>
        </>
      )}

      {!info && !loading && !error && (
        <div className="flex-1 flex flex-col items-center justify-center text-slate-500 gap-2 py-8">
          <FileArchive size={40} className="opacity-40" />
          <p className="text-sm">上传 APK 后可查看类列表、搜索并进行大模型分析</p>
        </div>
      )}
    </div>
  );
};
