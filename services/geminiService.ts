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