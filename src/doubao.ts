/**
 * 豆包实时语音大模型连接模块
 *
 * 对接火山引擎（字节跳动）豆包端到端实时语音大模型 API
 * 文档：https://www.volcengine.com/docs/6561/1594356
 *
 * 协议说明：
 * - WebSocket 端点：wss://openspeech.bytedance.com/api/v3/realtime/dialogue
 * - 认证：HTTP Header（X-Api-App-ID、X-Api-Access-Key、X-Api-Resource-Id、X-Api-App-Key）
 * - 数据格式：二进制协议 = header(4B) + optional(event/session_id) + payload_size(4B) + payload
 * - 音频输入：PCM 16-bit, 16kHz, 单声道
 * - 音频输出：默认 OGG/Opus，可配置为 PCM 24kHz
 *
 * 二进制帧结构：
 * [header 4B] [optional fields] [payload_size 4B] [payload]
 *
 * header:
 *   Byte 0: protocol_version(4b) | header_size(4b) = 0x11
 *   Byte 1: message_type(4b) | flags(4b)
 *   Byte 2: serialization(4b) | compression(4b)
 *   Byte 3: reserved = 0x00
 *
 * optional (when flags & 0x04 = event):
 *   event_id: 4B (big-endian uint32)
 *   session_id_size: 4B (session events only)
 *   session_id: variable (session events only)
 */

/**
 * 豆包 WebSocket 端点
 * CF Workers fetch() 不支持 wss://，使用 https:// + Upgrade: websocket
 */
const DOUBAO_WS_URL =
  "https://openspeech.bytedance.com/api/v3/realtime/dialogue";

// ===================== 事件 ID 常量 =====================

/** 客户端事件 */
const CLIENT_EVENT = {
  StartConnection: 1,
  FinishConnection: 2,
  StartSession: 100,
  FinishSession: 102,
  TaskRequest: 200,    // 上传音频
  SayHello: 300,
  ChatTTSText: 500,
  ChatTextQuery: 501,
} as const;

/** 服务端事件 */
const SERVER_EVENT = {
  ConnectionStarted: 50,
  ConnectionFailed: 51,
  ConnectionFinished: 52,
  SessionStarted: 150,
  SessionFinished: 152,
  SessionFailed: 153,
  UsageResponse: 154,
  TTSSentenceStart: 350,
  TTSSentenceEnd: 351,
  TTSResponse: 352,
  TTSEnded: 359,
  ASRInfo: 450,
  ASRResponse: 451,
  ASREnded: 459,
  ChatResponse: 550,
  ChatTextQueryConfirmed: 553,
  ChatEnded: 559,
  DialogCommonError: 599,
} as const;

/** Message Type */
const MSG_TYPE = {
  FullClientRequest: 0x1,
  AudioOnlyRequest: 0x2,
  FullServerResponse: 0x9,
  AudioOnlyResponse: 0xb,
  ErrorInfo: 0xf,
} as const;

/** Flags */
const FLAGS = {
  None: 0x0,
  Event: 0x4,
} as const;

/** Serialization */
const SERIAL = {
  Raw: 0x0,
  JSON: 0x1,
} as const;

// ===================== 配置接口 =====================

export interface DoubaoSessionConfig {
  /** Access Token (API Key) */
  apiKey: string;
  /** App ID (from console) */
  appId?: string;
  /** 面试的 system prompt */
  systemPrompt: string;
  /** 语音音色 */
  voice?: string;
  /** 会话 ID (UUID) */
  sessionId?: string;
}

// ===================== 连接信息 =====================

/**
 * 构建连接豆包 WebSocket 所需的 URL 和 Headers
 */
export function getDoubaoConnectionInfo(config: DoubaoSessionConfig): {
  url: string;
  headers: Record<string, string>;
} {
  return {
    url: DOUBAO_WS_URL,
    headers: {
      // App ID（从火山引擎控制台获取）
      "X-Api-App-ID": config.appId || "",
      // Access Token / API Key
      "X-Api-Access-Key": config.apiKey,
      // 固定值：实时语音对话服务
      "X-Api-Resource-Id": "volc.speech.dialog",
      // 固定值（文档指定）
      "X-Api-App-Key": "PlgvMymc7f3tQnJ6",
      // 可选：连接追踪 ID
      "X-Api-Connect-Id": `bole-${Date.now()}`,
    },
  };
}

// ===================== 客户端消息构建 =====================

/**
 * 构建 StartConnection 消息（WebSocket 连接后发送的第一条消息）
 * event ID = 1, connect-level（无 session ID）
 */
export function buildStartConnectionMessage(): ArrayBuffer {
  const payload = new TextEncoder().encode("{}");
  return buildFrame({
    messageType: MSG_TYPE.FullClientRequest,
    flags: FLAGS.Event,
    serialization: SERIAL.JSON,
    eventId: CLIENT_EVENT.StartConnection,
    payload,
  });
}

/**
 * 构建 StartSession 消息
 * event ID = 100, session-level（需要 session ID）
 */
export function buildStartSessionMessage(
  config: DoubaoSessionConfig
): ArrayBuffer {
  const sessionPayload: Record<string, unknown> = {
    dialog: {
      bot_name: "伯乐面试官",
      system_role: config.systemPrompt,
      extra: {
        model: "O",
      },
    },
    tts: {
      audio_config: {
        channel: 1,
        format: "pcm_s16le",
        sample_rate: 24000,
      },
      speaker: config.voice || "zh_male_yunzhou_jupiter_bigtts",
    },
    asr: {
      audio_info: {
        format: "pcm",
        sample_rate: 16000,
        channel: 1,
      },
    },
  };

  const payload = new TextEncoder().encode(JSON.stringify(sessionPayload));
  return buildFrame({
    messageType: MSG_TYPE.FullClientRequest,
    flags: FLAGS.Event,
    serialization: SERIAL.JSON,
    eventId: CLIENT_EVENT.StartSession,
    sessionId: config.sessionId,
    payload,
  });
}

/**
 * 构建 TaskRequest 音频消息
 * event ID = 200, session-level
 */
export function buildAudioMessage(
  pcmData: ArrayBuffer,
  sessionId: string
): ArrayBuffer {
  return buildFrame({
    messageType: MSG_TYPE.AudioOnlyRequest,
    flags: FLAGS.Event,
    serialization: SERIAL.Raw,
    eventId: CLIENT_EVENT.TaskRequest,
    sessionId,
    payload: new Uint8Array(pcmData),
  });
}

/**
 * 构建 FinishSession 消息
 * event ID = 102, session-level
 */
export function buildFinishSessionMessage(sessionId: string): ArrayBuffer {
  const payload = new TextEncoder().encode("{}");
  return buildFrame({
    messageType: MSG_TYPE.FullClientRequest,
    flags: FLAGS.Event,
    serialization: SERIAL.JSON,
    eventId: CLIENT_EVENT.FinishSession,
    sessionId,
    payload,
  });
}

// ===================== 通用帧构建器 =====================

interface FrameOptions {
  messageType: number;
  flags: number;
  serialization: number;
  eventId?: number;
  sessionId?: string;
  payload: Uint8Array;
}

/**
 * 构建二进制帧
 *
 * 帧结构：[header 4B] [event_id 4B?] [sid_size 4B?] [sid ?B] [payload_size 4B] [payload]
 */
function buildFrame(opts: FrameOptions): ArrayBuffer {
  const parts: Uint8Array[] = [];

  // Header (4 bytes)
  const header = new Uint8Array(4);
  header[0] = 0x11; // protocol v1, header size 1
  header[1] = (opts.messageType << 4) | (opts.flags & 0x0f);
  header[2] = (opts.serialization << 4) | 0x00; // no compression
  header[3] = 0x00; // reserved
  parts.push(header);

  // Optional: event ID (4 bytes, big-endian)
  if (opts.flags & FLAGS.Event && opts.eventId !== undefined) {
    const eventBuf = new Uint8Array(4);
    const eventView = new DataView(eventBuf.buffer);
    eventView.setUint32(0, opts.eventId);
    parts.push(eventBuf);
  }

  // Optional: session ID (for session-level events)
  if (opts.sessionId) {
    const sidBytes = new TextEncoder().encode(opts.sessionId);
    const sidSizeBuf = new Uint8Array(4);
    const sidSizeView = new DataView(sidSizeBuf.buffer);
    sidSizeView.setUint32(0, sidBytes.length);
    parts.push(sidSizeBuf);
    parts.push(sidBytes);
  }

  // Payload size (4 bytes, big-endian)
  const payloadSizeBuf = new Uint8Array(4);
  const payloadSizeView = new DataView(payloadSizeBuf.buffer);
  payloadSizeView.setUint32(0, opts.payload.length);
  parts.push(payloadSizeBuf);

  // Payload
  parts.push(opts.payload);

  // Merge all parts
  const totalSize = parts.reduce((sum, p) => sum + p.length, 0);
  const result = new Uint8Array(totalSize);
  let offset = 0;
  for (const part of parts) {
    result.set(part, offset);
    offset += part.length;
  }
  return result.buffer;
}

// ===================== 响应解析 =====================

export type DoubaoResponse =
  | { type: "connection_started" }
  | { type: "connection_failed"; error: string }
  | { type: "session_started"; dialogId: string; sessionId: string }
  | { type: "session_finished" }
  | { type: "session_failed"; error: string }
  | { type: "audio"; data: ArrayBuffer }
  | { type: "tts_sentence_start"; text: string }
  | { type: "tts_ended" }
  | { type: "asr_info" }
  | { type: "asr_response"; text: string; isInterim: boolean }
  | { type: "asr_ended" }
  | { type: "chat_response"; text: string }
  | { type: "chat_ended" }
  | { type: "error"; code: number; message: string }
  | { type: "unknown"; eventId: number; raw: unknown };

/**
 * 解析豆包服务端返回的二进制帧
 */
export function parseDoubaoMessage(data: ArrayBuffer): DoubaoResponse {
  if (data.byteLength < 4) {
    return { type: "error", code: -1, message: "frame too short" };
  }

  const view = new DataView(data);
  let offset = 0;

  // Header (4 bytes)
  const byte1 = view.getUint8(1);
  const byte2 = view.getUint8(2);
  const messageType = (byte1 >> 4) & 0x0f;
  const flags = byte1 & 0x0f;
  const serialization = (byte2 >> 4) & 0x0f;
  offset = 4;

  // Error frame
  if (messageType === MSG_TYPE.ErrorInfo) {
    // error code (4 bytes) if present
    let errorCode = -1;
    if (offset + 4 <= data.byteLength) {
      errorCode = view.getUint32(offset);
      offset += 4;
    }
    // Try to read payload
    if (offset + 4 <= data.byteLength) {
      const payloadSize = view.getUint32(offset);
      offset += 4;
      if (offset + payloadSize <= data.byteLength) {
        const payloadBuf = data.slice(offset, offset + payloadSize);
        const text = new TextDecoder().decode(payloadBuf);
        try {
          const json = JSON.parse(text);
          return { type: "error", code: errorCode, message: json.error || text };
        } catch {
          return { type: "error", code: errorCode, message: text };
        }
      }
    }
    return { type: "error", code: errorCode, message: "Unknown error" };
  }

  // Read event ID if flags has event bit
  let eventId = 0;
  if (flags & FLAGS.Event) {
    if (offset + 4 > data.byteLength) {
      return { type: "error", code: -1, message: "missing event id" };
    }
    eventId = view.getUint32(offset);
    offset += 4;
  }

  // Read session ID if it's a session-level event (eventId >= 100)
  let sessionId = "";
  if (eventId >= 100 && eventId < 600) {
    if (offset + 4 > data.byteLength) {
      return { type: "error", code: -1, message: "missing session id size" };
    }
    const sidSize = view.getUint32(offset);
    offset += 4;
    if (sidSize > 0 && offset + sidSize <= data.byteLength) {
      sessionId = new TextDecoder().decode(data.slice(offset, offset + sidSize));
      offset += sidSize;
    }
  }

  // Read payload
  if (offset + 4 > data.byteLength) {
    // Some events may not have payload
    return handleEvent(eventId, null, sessionId);
  }
  const payloadSize = view.getUint32(offset);
  offset += 4;

  if (payloadSize === 0) {
    return handleEvent(eventId, null, sessionId);
  }

  const payloadBuf = data.slice(offset, offset + payloadSize);

  // Audio response (raw binary)
  if (
    messageType === MSG_TYPE.AudioOnlyResponse ||
    (serialization === SERIAL.Raw && eventId === SERVER_EVENT.TTSResponse)
  ) {
    return { type: "audio", data: payloadBuf };
  }

  // JSON response
  if (serialization === SERIAL.JSON) {
    try {
      const text = new TextDecoder().decode(payloadBuf);
      const json = JSON.parse(text);
      return handleEvent(eventId, json, sessionId);
    } catch {
      return handleEvent(eventId, null, sessionId);
    }
  }

  // Raw non-audio (might be audio from TTSResponse)
  if (serialization === SERIAL.Raw && payloadSize > 0) {
    return { type: "audio", data: payloadBuf };
  }

  return { type: "unknown", eventId, raw: null };
}

/**
 * 根据事件 ID 和 JSON payload 构建响应
 */
function handleEvent(
  eventId: number,
  json: Record<string, unknown> | null,
  sessionId: string
): DoubaoResponse {
  switch (eventId) {
    case SERVER_EVENT.ConnectionStarted:
      return { type: "connection_started" };

    case SERVER_EVENT.ConnectionFailed:
      return {
        type: "connection_failed",
        error: (json?.error as string) || "Connection failed",
      };

    case SERVER_EVENT.SessionStarted:
      return {
        type: "session_started",
        dialogId: (json?.dialog_id as string) || "",
        sessionId,
      };

    case SERVER_EVENT.SessionFinished:
      return { type: "session_finished" };

    case SERVER_EVENT.SessionFailed:
      return {
        type: "session_failed",
        error: (json?.error as string) || "Session failed",
      };

    case SERVER_EVENT.TTSSentenceStart:
      return {
        type: "tts_sentence_start",
        text: (json?.text as string) || "",
      };

    case SERVER_EVENT.TTSSentenceEnd:
    case SERVER_EVENT.TTSEnded:
      return { type: "tts_ended" };

    case SERVER_EVENT.TTSResponse:
      // Should have been handled as audio above
      return { type: "unknown", eventId, raw: json };

    case SERVER_EVENT.ASRInfo:
      return { type: "asr_info" };

    case SERVER_EVENT.ASRResponse: {
      const results = json?.results as Array<{
        text?: string;
        is_interim?: boolean;
      }>;
      if (results && results.length > 0) {
        return {
          type: "asr_response",
          text: results[0].text || "",
          isInterim: results[0].is_interim || false,
        };
      }
      return { type: "asr_response", text: "", isInterim: false };
    }

    case SERVER_EVENT.ASREnded:
      return { type: "asr_ended" };

    case SERVER_EVENT.ChatResponse:
      return {
        type: "chat_response",
        text: (json?.content as string) || "",
      };

    case SERVER_EVENT.ChatEnded:
      return { type: "chat_ended" };

    case SERVER_EVENT.DialogCommonError:
      return {
        type: "error",
        code: (json?.status_code as number) || -1,
        message: (json?.message as string) || "Dialog error",
      };

    case SERVER_EVENT.UsageResponse:
    case SERVER_EVENT.ChatTextQueryConfirmed:
    case SERVER_EVENT.ConnectionFinished:
      // 信息性事件，忽略
      return { type: "unknown", eventId, raw: json };

    default:
      return { type: "unknown", eventId, raw: json };
  }
}
