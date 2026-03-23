import React, { useState, useEffect } from 'react';
import { X, KeyRound, Cpu, Save } from 'lucide-react';
import {
  loadPersistedGeminiConfig,
  savePersistedGeminiConfig,
  DEFAULT_GEMINI_MODEL,
} from '../services/aiModelConfig';

interface AIModelConfigModalProps {
  open: boolean;
  onClose: () => void;
  onSaved?: () => void;
}

/**
 * 仅 Google Gemini：API Key + 模型代号，写入 localStorage。
 */
export const AIModelConfigModal: React.FC<AIModelConfigModalProps> = ({ open, onClose, onSaved }) => {
  const [modelCode, setModelCode] = useState(DEFAULT_GEMINI_MODEL);
  const [apiKey, setApiKey] = useState('');
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setError(null);
    const existing = loadPersistedGeminiConfig();
    if (existing) {
      setModelCode(existing.modelCode);
      setApiKey(existing.apiKey);
    } else {
      setModelCode(DEFAULT_GEMINI_MODEL);
      setApiKey('');
    }
  }, [open]);

  const handleSave = () => {
    const key = apiKey.trim();
    const model = modelCode.trim() || DEFAULT_GEMINI_MODEL;
    if (!key) {
      setError('请填写 Google AI Studio / Gemini API Key');
      return;
    }

    setSaving(true);
    setError(null);
    try {
      savePersistedGeminiConfig({ apiKey: key, modelCode: model });
      onSaved?.();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  };

  if (!open) return null;

  return (
    <div className="fixed inset-0 z-[120] flex items-center justify-center p-4">
      <div className="absolute inset-0 bg-black/60 backdrop-blur-sm" aria-hidden onClick={onClose} />
      <div
        role="dialog"
        aria-labelledby="ai-config-title"
        className="relative z-10 w-full max-w-md rounded-xl border border-slate-700 bg-slate-900 shadow-2xl"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-center justify-between border-b border-slate-800 px-4 py-3">
          <h2 id="ai-config-title" className="flex items-center gap-2 text-sm font-bold text-cyan-300">
            <Cpu size={18} />
            配置 Google Gemini
          </h2>
          <button
            type="button"
            onClick={onClose}
            className="rounded p-1 text-slate-400 hover:bg-slate-800 hover:text-white"
            aria-label="关闭"
          >
            <X size={18} />
          </button>
        </div>

        <div className="max-h-[min(80vh,520px)] space-y-3 overflow-y-auto px-4 py-4">
          <p className="text-[10px] leading-relaxed text-slate-500">
            本工具 AI 功能（对话、Trace/反编译分析、截图自动化等）均使用 <strong className="text-slate-400">Google Gemini</strong>
            。Key 保存在本机浏览器；也可在项目根 <code className="rounded bg-slate-800 px-0.5">.env.local</code> 配置{' '}
            <code className="rounded bg-slate-800 px-0.5">GEMINI_API_KEY</code> 作为兜底（无需在此重复填写）。
          </p>

          <div>
            <label className="mb-1 block text-[10px] font-medium uppercase tracking-wide text-slate-500">
              模型代号
            </label>
            <input
              value={modelCode}
              onChange={(e) => setModelCode(e.target.value)}
              placeholder={DEFAULT_GEMINI_MODEL}
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-cyan-300 placeholder:text-slate-600"
            />
            <p className="mt-1 text-[10px] text-slate-600">
              多模态/截图建议选带 flash 的型号（如 gemini-2.0-flash）；以 Google 文档为准。
            </p>
          </div>

          <div>
            <label className="mb-1 flex items-center gap-1 text-[10px] font-medium uppercase tracking-wide text-slate-500">
              <KeyRound size={12} />
              API Key
            </label>
            <input
              type="password"
              value={apiKey}
              onChange={(e) => setApiKey(e.target.value)}
              placeholder="从 Google AI Studio 获取"
              autoComplete="off"
              className="w-full rounded-lg border border-slate-700 bg-slate-950 px-3 py-2 font-mono text-xs text-slate-200 placeholder:text-slate-600"
            />
          </div>

          {error && (
            <p className="rounded border border-red-900/50 bg-red-950/30 px-2 py-1.5 text-[11px] text-red-200">{error}</p>
          )}
        </div>

        <div className="flex flex-wrap gap-2 border-t border-slate-800 px-4 py-3">
          <button
            type="button"
            onClick={handleSave}
            disabled={saving}
            className="inline-flex flex-1 items-center justify-center gap-2 rounded-lg bg-cyan-600 px-4 py-2 text-sm font-medium text-white hover:bg-cyan-500 disabled:opacity-50"
          >
            {saving ? '保存中…' : (
              <>
                <Save size={16} />
                保存并使用
              </>
            )}
          </button>
          <button
            type="button"
            onClick={onClose}
            className="rounded-lg border border-slate-600 px-4 py-2 text-sm text-slate-300 hover:bg-slate-800"
          >
            稍后再说
          </button>
        </div>
      </div>
    </div>
  );
};
