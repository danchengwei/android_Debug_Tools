import { GoogleGenAI, Type } from "@google/genai";
import { AIAction } from "../types";


export const getNextAutomationAction = async (base64Image: string, goal: string, history: string[]): Promise<AIAction> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key not found");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  
  let rawBase64 = base64Image;
  if (base64Image.includes(',')) {
    rawBase64 = base64Image.split(',')[1];
  }

  const prompt = `你是一个 Android 自动化测试专家。
当前目标: ${goal}
历史操作: ${history.join(' -> ') || '无'}

请分析当前屏幕截图，并决定下一步操作。
屏幕分辨率假设为 1080x1920。
如果是点击，请提供相对坐标 (x, y)。
如果是输入，请提供文本。
如果是滚动，请提供方向。
如果已完成目标，请返回 finish。

必须返回 JSON 格式。`;

  const response = await ai.models.generateContent({
    model: 'gemini-2.5-flash-image',
    contents: {
      parts: [
        { text: prompt },
        {
          inlineData: {
            mimeType: 'image/png',
            data: rawBase64
          }
        }
      ]
    },
    config: {
      responseMimeType: "application/json",
      responseSchema: {
        type: Type.OBJECT,
        properties: {
          type: {
            type: Type.STRING,
            description: "操作类型: click, input, scroll, back, home, finish",
          },
          params: {
            type: Type.OBJECT,
            properties: {
              x: { type: Type.NUMBER, description: "点击的 X 坐标 (0-1080)" },
              y: { type: Type.NUMBER, description: "点击的 Y 坐标 (0-1920)" },
              text: { type: Type.STRING, description: "输入的文本" },
              direction: { type: Type.STRING, description: "滚动方向: up, down, left, right" },
              reason: { type: Type.STRING, description: "执行此操作的原因" }
            }
          }
        },
        required: ["type"]
      }
    }
  });

  try {
    return JSON.parse(response.text);
  } catch (e) {
    console.error("Failed to parse AI response", response.text);
    return { type: 'finish', params: { reason: "解析 AI 响应失败" } };
  }
};

// Note: In a production app, never expose keys in client-side code if not guarded by authentication/proxy.
// We assume process.env.API_KEY is available as per instructions.

export const analyzeScreenWithGemini = async (base64Image: string, promptText: string) => {
  if (!process.env.API_KEY) {
    throw new Error("API Key not found in environment variables");
  }

  try {
    const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
    
    // Convert the image data to the format expected by the SDK
    // If base64Image is a data URL (starts with "data:image/..."), strip the header
    let rawBase64 = base64Image;
    if (base64Image.includes(',')) {
      rawBase64 = base64Image.split(',')[1];
    }

    // Since our mock returns a URL (picsum), we can't actually send that URL to Gemini for "inlineData".
    // For this specific DEMO code, if the URL is http based, we will just send text.
    // If it were real base64, we would send the image.
    
    let parts: any[] = [{ text: promptText }];

    if (base64Image.startsWith('http')) {
        try {
            const response = await fetch(base64Image);
            const blob = await response.blob();
            const buffer = await blob.arrayBuffer();
            const bytes = new Uint8Array(buffer);
            let binary = '';
            const len = bytes.byteLength;
            for (let i = 0; i < len; i++) {
                binary += String.fromCharCode(bytes[i]);
            }
            rawBase64 = btoa(binary);
            
            parts.push({
                inlineData: {
                    mimeType: 'image/jpeg',
                    data: rawBase64
                }
            });
        } catch (e) {
            console.warn("Could not fetch placeholder image for Gemini analysis, falling back to text only.");
            parts[0].text = promptText + " (注意：图片获取失败，请仅根据上下文分析)";
        }
    } else {
         parts.push({
            inlineData: {
                mimeType: 'image/png',
                data: rawBase64
            }
        });
    }

    const response = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image',
      contents: {
        parts: parts
      },
      config: {
          systemInstruction: "你是一位资深的 Android 开发工程师和 UI/UX 设计师。请分析提供的应用截图，找出布局 Bug、文本可读性问题以及视图层级结构问题。请始终使用中文回复。"
      }
    });

    return response.text;

  } catch (error) {
    console.error("Gemini Analysis Failed:", error);
    throw error;
  }
};

/**
 * 基于反编译得到的类列表，用大模型回答用户问题（例如「当前反编译是否使用了 xxx 类」）。
 */
export const analyzeDecompiledWithGemini = async (
  classes: string[],
  userQuestion: string
): Promise<string> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key not found in environment variables");
  }

  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const classListText = classes.length > 500
    ? classes.slice(0, 500).join("\n") + `\n... 等共 ${classes.length} 个类（已截断前 500 个）`
    : classes.join("\n");

  const systemInstruction =
    "你是一位 Android 逆向与安全分析专家。用户会提供一份从 APK 反编译得到的类列表（DEX 中的类描述符，如 Lcom/example/Main;），以及一个自然语言问题。请仅根据这份类列表回答：例如是否使用了某类、某 SDK、某包名等。回答要简洁、准确，使用中文。若类列表为空或无法判断，请说明。";

  const prompt = `【反编译类列表】\n${classListText}\n\n【用户问题】\n${userQuestion}`;

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: { parts: [{ text: prompt }] },
    config: { systemInstruction },
  });

  return response.text ?? "未得到有效回复。";
};

/**
 * 对 trace 原始内容或摘要做简要分析（卡顿、掉帧、建议等），使用中文回复。
 */
export const analyzeTraceWithGemini = async (traceContentOrSummary: string): Promise<string> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key not found in environment variables");
  }
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });
  const excerpt =
    traceContentOrSummary.length > 30000
      ? traceContentOrSummary.slice(0, 30000) + "\n\n... (已截断)"
      : traceContentOrSummary;
  const systemInstruction =
    "你是一位 Android 性能与 systrace/atrace 分析专家。用户会提供一段 trace 原始输出或摘要。请从渲染、主线程、掉帧、卡顿、IPC 等角度给出简要结论与优化建议，使用中文，条理清晰。";
  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: { parts: [{ text: `【Trace 内容】\n${excerpt}\n\n请给出简要分析与建议。` }] },
    config: { systemInstruction },
  });
  return response.text ?? "未得到有效回复。";
};

/** 调试对话中的一条消息 */
export interface DebugChatMessage {
  role: 'user' | 'model';
  content: string;
}

/**
 * 基于当前调试上下文与 AI 多轮对话。systemContext 由调用方从 device/栈/环境/布局/日志/trace/反编译 等拼成。
 */
export const chatWithDebugContext = async (
  systemContext: string,
  userMessage: string,
  history: DebugChatMessage[] = []
): Promise<string> => {
  if (!process.env.API_KEY) {
    throw new Error("API Key not found in environment variables");
  }
  const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

  const systemInstruction =
    "你是一位资深的 Android 开发与调试专家，熟悉设备信息、Activity 栈、环境配置、布局层级、logcat、systrace/atrace、反编译类列表等。用户会提供当前调试上下文的摘要，并可能追问。请根据上下文和对话历史，用中文简洁、准确地回答；若信息不足请说明。";

  const parts: { text: string }[] = [];
  for (const msg of history) {
    parts.push({ text: `${msg.role === 'user' ? '用户' : '助手'}: ${msg.content}\n` });
  }
  parts.push({
    text: `用户: ${userMessage}\n\n请根据以下上下文回答。\n\n【当前调试上下文】\n${systemContext}`,
  });

  const response = await ai.models.generateContent({
    model: "gemini-2.0-flash",
    contents: { parts },
    config: { systemInstruction },
  });

  return response.text ?? "未得到有效回复。";
};