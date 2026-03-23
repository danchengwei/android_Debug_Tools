/**
 * AI 仅使用 Google Gemini：浏览器 localStorage 持久化 + 构建时 GEMINI_API_KEY 兜底。
 * 注意：Key 存于本机浏览器，请勿在公共电脑上使用。
 */

const STORAGE_KEY = 'droidscope_ai_model_config_v1';

/** 默认文本/多轮对话模型；视觉能力请优先选带 flash 的 Gemini 多模态型号 */
export const DEFAULT_GEMINI_MODEL = 'gemini-2.0-flash';

/** 与 localStorage 中保存的 JSON 一致（仅 Key + 模型代号） */
export interface PersistedGeminiConfig {
  apiKey: string;
  modelCode: string;
}

export type GeminiConfigSource = 'persisted' | 'env';

export interface EffectiveGeminiConfig extends PersistedGeminiConfig {
  source: GeminiConfigSource;
}

/** 兼容旧代码命名 */
export type EffectiveAiConfig = EffectiveGeminiConfig;

/** 读取构建时注入的 Key（Vite define → process.env.API_KEY） */
function readBuildTimeGeminiKey(): string {
  try {
    if (typeof process !== 'undefined' && process.env && typeof process.env.API_KEY === 'string') {
      return process.env.API_KEY.trim();
    }
  } catch {
    /* 忽略 */
  }
  return '';
}

/**
 * 从旧版（含 provider / baseUrl）迁移为仅 Gemini 字段；非 Gemini 的旧配置视为无效。
 */
function tryMigrateLegacyJson(j: Record<string, unknown>): PersistedGeminiConfig | null {
  const apiKey = typeof j.apiKey === 'string' ? j.apiKey.trim() : '';
  const modelCode = typeof j.modelCode === 'string' ? j.modelCode.trim() : '';
  if (!apiKey || !modelCode) return null;

  const provider = j.provider;
  if (provider === undefined) {
    return { apiKey, modelCode };
  }
  if (provider === 'google_gemini') {
    return { apiKey, modelCode };
  }
  return null;
}

export function loadPersistedGeminiConfig(): PersistedGeminiConfig | null {
  if (typeof window === 'undefined' || !window.localStorage) return null;
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const j = JSON.parse(raw) as Record<string, unknown>;
    if (!j || typeof j !== 'object') return null;
    const migrated = tryMigrateLegacyJson(j);
    if (!migrated) {
      if ('provider' in j) {
        window.localStorage.removeItem(STORAGE_KEY);
      }
      return null;
    }
    if ('provider' in j) {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(migrated));
    }
    return migrated;
  } catch {
    return null;
  }
}

/** @deprecated 使用 loadPersistedGeminiConfig */
export const loadPersistedAiConfig = loadPersistedGeminiConfig;

export function savePersistedGeminiConfig(config: PersistedGeminiConfig): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  const payload: PersistedGeminiConfig = {
    apiKey: config.apiKey.trim(),
    modelCode: config.modelCode.trim() || DEFAULT_GEMINI_MODEL,
  };
  window.localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

/** @deprecated 使用 savePersistedGeminiConfig */
export function savePersistedAiConfig(config: PersistedGeminiConfig): void {
  savePersistedGeminiConfig(config);
}

export function clearPersistedGeminiConfig(): void {
  if (typeof window === 'undefined' || !window.localStorage) return;
  window.localStorage.removeItem(STORAGE_KEY);
}

export const clearPersistedAiConfig = clearPersistedGeminiConfig;

/**
 * 有效配置：优先本地持久化；否则使用打包时 .env 中的 GEMINI_API_KEY。
 */
export function getEffectiveGeminiConfig(): EffectiveGeminiConfig | null {
  const stored = loadPersistedGeminiConfig();
  if (stored) {
    return { ...stored, source: 'persisted' };
  }
  const envKey = readBuildTimeGeminiKey();
  if (envKey) {
    return {
      source: 'env',
      apiKey: envKey,
      modelCode: DEFAULT_GEMINI_MODEL,
    };
  }
  return null;
}

/** @deprecated 使用 getEffectiveGeminiConfig */
export const getEffectiveAiModelConfig = getEffectiveGeminiConfig;

export function isAiModelConfigured(): boolean {
  return getEffectiveGeminiConfig() !== null;
}
