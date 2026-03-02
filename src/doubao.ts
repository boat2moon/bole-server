/**
 * 豆包实时语音大模型连接模块
 *
 * 对接火山引擎（字节跳动）豆包端到端实时语音大模型 API
 * 文档：https://www.volcengine.com/docs/6561/1594356
 *
 * 协议说明：
 * - WebSocket 端点：wss://openspeech.bytedance.com/api/v3/realtime/dialogue
 * - 认证：通过 HTTP Header（X-Api-App-Key、X-Api-Access-Key、X-Api-Resource-Id）
 * - 数据格式：二进制协议（4字节头 + payload）
 * - 音频格式：PCM 16-bit, 16kHz, 单声道
 * - 推荐发送频率：20ms/包（640字节 PCM）
 *
 * 二进制协议头部格式（4 字节）：
 * Byte 0: [protocol_version(4bit) | header_size(4bit)]
 *         protocol_version = 0x1, header_size = 0x1 (1个4字节, 即4字节头)
 * Byte 1: [message_type(4bit) | message_type_specific_flags(4bit)]
 *         message_type: 0x1=full_client_request, 0x2=audio_only_request,
 *                       0x9=full_server_response, 0xF=error
 *         flags: 0x1=序列开始, 0x2=序列结束, 0x3=单独一包
 * Byte 2: [serialization_method(4bit) | compression_method(4bit)]
 *         serialization: 0x1=JSON, 0x0=none
 *         compression: 0x0=none, 0x1=gzip
 * Byte 3: reserved = 0x00
 *
 * payload 前面有 4 字节的 payload_size（大端序 uint32）
 */

/** 
 * 豆包实时语音 WebSocket 端点
 * 
 * 注意：CF Workers 的 fetch() 不支持 wss://，
 * 需要使用 https:// + Upgrade: websocket header
 */
const DOUBAO_WS_URL =
  "https://openspeech.bytedance.com/api/v3/realtime/dialogue";

export interface DoubaoSessionConfig {
  /** API Key */
  apiKey: string;
  /** 模型/资源 ID（在火山控制台获取） */
  resourceId?: string;
  /** App ID */
  appId?: string;
  /** 面试的 system prompt */
  systemPrompt: string;
  /** 语音音色 */
  voice?: string;
}

/**
 * 构建连接豆包 WebSocket 所需的 URL 和 Headers
 *
 * 豆包的认证信息通过 HTTP Header 传递（不是 URL 参数）
 */
export function getDoubaoConnectionInfo(config: DoubaoSessionConfig): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url: DOUBAO_WS_URL,
    headers: {
      // App ID（从火山引擎控制台-语音技术-应用管理获取）
      "X-Api-App-Key": config.appId || "",
      // Access Token / API Key
      "X-Api-Access-Key": config.apiKey,
      // 固定值：实时语音对话服务
      "X-Api-Resource-Id": "volc.speech.dialog",
      // 可选：连接追踪 ID（方便排查问题）
      "X-Api-Connect-Id": `bole-${Date.now()}`,
    },
  };
}

// ===================== 二进制协议构建 =====================

/**
 * 构建 StartSession 消息（连接后发送的第一条消息）
 *
 * message_type = 0x1 (full_client_request)
 * flags = 0x1 (序列开始)
 * serialization = 0x1 (JSON)
 * compression = 0x0 (none)
 */
export function buildStartSessionMessage(config: DoubaoSessionConfig): ArrayBuffer {
  const payload = JSON.stringify({
    event: "StartSession",
    config: {
      session: {
        mode: "voice_chat",
      },
      audio: {
        input: {
          encoding: "pcm",
          sample_rate: 16000,
          bits: 16,
          channel: 1,
        },
        output: {
          encoding: "pcm",
          sample_rate: 24000,
          bits: 16,
          channel: 1,
        },
      },
      dialog: {
        system_prompt: config.systemPrompt,
        extra: {
          // 允许打断
          allow_interrupt: true,
        },
      },
    },
  });

  return buildBinaryMessage(0x1, 0x1, payload);
}

/**
 * 构建音频数据消息
 *
 * message_type = 0x2 (audio_only_request)
 * flags = 0x0 (普通包)
 * serialization = 0x0 (none, 纯二进制音频)
 * compression = 0x0 (none)
 *
 * @param pcmData - PCM 16-bit 16kHz 单声道音频数据
 */
export function buildAudioMessage(pcmData: ArrayBuffer): ArrayBuffer {
  // 4字节头 + 4字节 payload size + payload
  const headerAndSize = new ArrayBuffer(8);
  const view = new DataView(headerAndSize);

  // Byte 0: protocol_version(1) | header_size(1)
  view.setUint8(0, 0x11);
  // Byte 1: message_type(2=audio_only) | flags(0=normal)
  view.setUint8(1, 0x20);
  // Byte 2: serialization(0=none) | compression(0=none)
  view.setUint8(2, 0x00);
  // Byte 3: reserved
  view.setUint8(3, 0x00);
  // Payload size (big endian uint32)
  view.setUint32(4, pcmData.byteLength);

  // 合并 header + size + payload
  const result = new Uint8Array(8 + pcmData.byteLength);
  result.set(new Uint8Array(headerAndSize), 0);
  result.set(new Uint8Array(pcmData), 8);
  return result.buffer;
}

/**
 * 构建 FinishSession 消息
 *
 * message_type = 0x1 (full_client_request)
 * flags = 0x2 (序列结束)
 */
export function buildFinishSessionMessage(): ArrayBuffer {
  const payload = JSON.stringify({
    event: "FinishSession",
  });
  return buildBinaryMessage(0x1, 0x2, payload);
}

/**
 * 通用二进制消息构建器
 *
 * @param messageType - 消息类型 (0x1=full_client_request, 0x2=audio_only)
 * @param flags - 标志位 (0x1=start, 0x2=end, 0x3=single)
 * @param jsonPayload - JSON 字符串 payload
 */
function buildBinaryMessage(
  messageType: number,
  flags: number,
  jsonPayload: string
): ArrayBuffer {
  const payloadBytes = new TextEncoder().encode(jsonPayload);

  // 4字节头 + 4字节 payload size + payload
  const buffer = new ArrayBuffer(8 + payloadBytes.length);
  const view = new DataView(buffer);

  // Byte 0: protocol_version(1) | header_size(1)
  view.setUint8(0, 0x11);
  // Byte 1: message_type | flags
  view.setUint8(1, (messageType << 4) | (flags & 0x0f));
  // Byte 2: serialization(1=JSON) | compression(0=none)
  view.setUint8(2, 0x10);
  // Byte 3: reserved
  view.setUint8(3, 0x00);
  // Payload size (big endian uint32)
  view.setUint32(4, payloadBytes.length);

  // Write payload
  const payloadView = new Uint8Array(buffer, 8);
  payloadView.set(payloadBytes);

  return buffer;
}

// ===================== 响应解析 =====================

export type DoubaoResponse =
  | { type: "session_started"; sessionId: string }
  | { type: "audio"; data: ArrayBuffer }
  | { type: "text"; text: string; role: "assistant" | "user" }
  | { type: "turn_complete" }
  | { type: "session_finished" }
  | { type: "error"; code: number; message: string }
  | { type: "unknown"; raw: unknown };

/**
 * 解析豆包服务端返回的二进制消息
 *
 * 服务端消息 message_type = 0x9 (full_server_response) 或音频数据
 */
export function parseDoubaoMessage(data: ArrayBuffer): DoubaoResponse {
  if (data.byteLength < 8) {
    return { type: "unknown", raw: "message too short" };
  }

  const view = new DataView(data);

  // 解析头部
  const byte1 = view.getUint8(1);
  const messageType = (byte1 >> 4) & 0x0f;
  const byte2 = view.getUint8(2);
  const serialization = (byte2 >> 4) & 0x0f;

  // 获取 payload
  const payloadSize = view.getUint32(4);
  const payloadStart = 8;

  if (data.byteLength < payloadStart + payloadSize) {
    return { type: "unknown", raw: "incomplete payload" };
  }

  const payloadBuffer = data.slice(payloadStart, payloadStart + payloadSize);

  // 音频数据（服务端返回的音频，message_type 可能包含音频标记）
  if (serialization === 0x0 && payloadSize > 0) {
    // 纯二进制音频数据
    return { type: "audio", data: payloadBuffer };
  }

  // JSON 数据
  if (serialization === 0x1) {
    try {
      const jsonStr = new TextDecoder().decode(payloadBuffer);
      const json = JSON.parse(jsonStr);
      return parseDoubaoJsonEvent(json);
    } catch {
      return { type: "unknown", raw: "json parse error" };
    }
  }

  // 错误响应 (message_type = 0xF)
  if (messageType === 0xf) {
    try {
      const jsonStr = new TextDecoder().decode(payloadBuffer);
      const json = JSON.parse(jsonStr);
      return {
        type: "error",
        code: json.code || -1,
        message: json.message || "Unknown error",
      };
    } catch {
      return { type: "error", code: -1, message: "Binary error response" };
    }
  }

  return { type: "unknown", raw: `messageType=${messageType}` };
}

/**
 * 解析 JSON 格式的豆包事件
 */
function parseDoubaoJsonEvent(json: Record<string, unknown>): DoubaoResponse {
  const event = json.event as string;

  switch (event) {
    case "SessionStarted":
      return {
        type: "session_started",
        sessionId: (json.session_id as string) || "",
      };

    case "SessionFinished":
      return { type: "session_finished" };

    case "TurnEnd":
    case "turn_complete":
      return { type: "turn_complete" };

    case "TTSSentenceStart":
    case "TTSSentenceEnd":
      // TTS 相关事件，可忽略
      return { type: "unknown", raw: json };

    case "ASRSentenceEnd":
      // 用户语音识别结果
      return {
        type: "text",
        text: (json.text as string) || "",
        role: "user",
      };

    case "LLMResponseText":
      // LLM 文本响应（用于字幕）
      return {
        type: "text",
        text: (json.text as string) || "",
        role: "assistant",
      };

    default:
      // 检查是否有 text 字段（兜底）
      if (json.text && typeof json.text === "string") {
        return { type: "text", text: json.text, role: "assistant" };
      }
      return { type: "unknown", raw: json };
  }
}
