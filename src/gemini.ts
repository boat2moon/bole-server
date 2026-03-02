/**
 * Gemini Live API 连接模块
 *
 * 负责与 Google Gemini 2.0 Flash Live API 建立 WebSocket 连接
 * 并处理双向音频流的透传。
 *
 * Gemini Live API 协议说明：
 * - 连接端点：wss://generativelanguage.googleapis.com/ws/...
 * - 首条消息：发送 setup 配置（model, systemInstruction, generationConfig 等等）
 * - 后续消息：双向传输音频数据（base64 编码的 PCM/音频块）
 *
 * 参考文档：
 * https://ai.google.dev/api/multimodal-live
 */

/** Gemini Live API 的 WebSocket 端点 */
const GEMINI_WS_BASE =
  "wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent";

export interface GeminiSessionConfig {
  apiKey: string;
  model: string;
  systemPrompt: string;
  voice?: string;
}

/**
 * 创建与 Gemini Live API 的 WebSocket 连接
 *
 * @returns WebSocket 实例，已发送 setup 消息
 */
export function connectToGemini(config: GeminiSessionConfig): WebSocket {
  const wsUrl = `${GEMINI_WS_BASE}?key=${config.apiKey}`;
  const ws = new WebSocket(wsUrl);
  return ws;
}

/**
 * 构建 Gemini setup 消息
 *
 * 这是连接建立后发送的第一条消息，配置模型、语音、系统指令等。
 */
export function buildSetupMessage(config: GeminiSessionConfig): string {
  return JSON.stringify({
    setup: {
      model: `models/${config.model}`,
      generationConfig: {
        responseModalities: ["AUDIO"],
        speechConfig: {
          voiceConfig: {
            prebuiltVoiceConfig: {
              voiceName: config.voice || "Aoede",
            },
          },
        },
      },
      systemInstruction: {
        parts: [
          {
            text: config.systemPrompt,
          },
        ],
      },
    },
  });
}

/**
 * 构建发送音频数据的消息
 *
 * 将客户端传来的音频数据包装成 Gemini 协议格式
 *
 * @param audioBase64 - Base64 编码的音频数据（PCM 16-bit, 16kHz）
 */
export function buildAudioInputMessage(audioBase64: string): string {
  return JSON.stringify({
    realtimeInput: {
      mediaChunks: [
        {
          mimeType: "audio/pcm;rate=16000",
          data: audioBase64,
        },
      ],
    },
  });
}

/**
 * 解析 Gemini 返回的消息
 *
 * Gemini Live API 的响应类型包括：
 * - setupComplete: 连接初始化完成
 * - serverContent: 模型生成的内容（音频/文本）
 * - toolCall: 函数调用请求
 */
export type GeminiResponse =
  | { type: "setupComplete" }
  | { type: "audio"; data: string; mimeType: string }
  | { type: "text"; text: string }
  | { type: "turnComplete" }
  | { type: "interrupted" }
  | { type: "unknown"; raw: unknown };

export function parseGeminiMessage(message: string): GeminiResponse {
  try {
    const parsed = JSON.parse(message);

    // 连接建立完成
    if (parsed.setupComplete !== undefined) {
      return { type: "setupComplete" };
    }

    // 服务端内容（音频/文本）
    if (parsed.serverContent) {
      const content = parsed.serverContent;

      // 检查是否被打断
      if (content.interrupted) {
        return { type: "interrupted" };
      }

      // 检查是否轮次结束
      if (content.turnComplete) {
        return { type: "turnComplete" };
      }

      // 解析模型输出的 parts
      const parts = content.modelTurn?.parts;
      if (parts && Array.isArray(parts)) {
        for (const part of parts) {
          // 音频输出
          if (part.inlineData) {
            return {
              type: "audio",
              data: part.inlineData.data,
              mimeType: part.inlineData.mimeType || "audio/pcm;rate=24000",
            };
          }
          // 文本输出（transcript）
          if (part.text) {
            return { type: "text", text: part.text };
          }
        }
      }
    }

    return { type: "unknown", raw: parsed };
  } catch {
    return { type: "unknown", raw: message };
  }
}
