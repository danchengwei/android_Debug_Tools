import { GoogleGenAI } from '@google/genai';
import type { EffectiveGeminiConfig, PersistedGeminiConfig } from './aiModelConfig';
import type { DebugChatMessage } from '../types';

type GeminiCallConfig = Pick<PersistedGeminiConfig, 'apiKey' | 'modelCode'>;

/**
 * Google Gemini 多轮调试对话。
 */
export async function chatDebugWithGemini(
  config: GeminiCallConfig,
  systemInstruction: string,
  systemContext: string,
  userMessage: string,
  history: DebugChatMessage[]
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const parts: { text: string }[] = [];
  for (const msg of history) {
    parts.push({ text: `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}\n` });
  }
  parts.push({
    text: `用户: ${userMessage}\n\n请根据以下上下文回答。\n\n【当前调试上下文】\n${systemContext}`,
  });
  const response = await ai.models.generateContent({
    model: config.modelCode,
    contents: { parts },
    config: { systemInstruction },
  });
  return response.text ?? '未得到有效回复。';
}

/**
 * Google Gemini 单轮文本（Trace / 反编译等）。
 */
export async function completeTextGoogleGemini(
  config: GeminiCallConfig,
  systemInstruction: string,
  userText: string
): Promise<string> {
  const ai = new GoogleGenAI({ apiKey: config.apiKey });
  const response = await ai.models.generateContent({
    model: config.modelCode,
    contents: { parts: [{ text: userText }] },
    config: { systemInstruction },
  });
  return response.text ?? '未得到有效回复。';
}

/** @deprecated 仅保留 Gemini，请使用 chatDebugWithGemini */
export async function chatDebugWithConfig(
  config: EffectiveGeminiConfig,
  systemInstruction: string,
  systemContext: string,
  userMessage: string,
  history: DebugChatMessage[]
): Promise<string> {
  return chatDebugWithGemini(config, systemInstruction, systemContext, userMessage, history);
}
