/**
 * RealtimeSession Durable Object
 *
 * 管理单个实时语音面试会话的完整生命周期：
 * 1. 接受客户端 WebSocket 连接
 * 2. 建立与豆包实时语音 API 的 WebSocket 连接
 * 3. 双向透传音频数据（客户端 base64 ↔ 豆包二进制协议）
 * 4. 处理面试中断、超时等异常情况
 *
 * 协议流程：
 * 1. 建立 WebSocket 连接 → 发送 StartConnection
 * 2. 收到 ConnectionStarted → 发送 StartSession
 * 3. 收到 SessionStarted → 通知客户端 ready
 * 4. 客户端发送音频 → 转为 TaskRequest 发给豆包
 * 5. 豆包返回事件 → 解析后透传给客户端
 */

import {
  type DoubaoSessionConfig,
  buildAudioMessage,
  buildFinishSessionMessage,
  buildStartConnectionMessage,
  buildStartSessionMessage,
  getDoubaoConnectionInfo,
  parseDoubaoMessage,
} from "./doubao";

/** 面试会话最大时长：30 分钟 */
const MAX_SESSION_DURATION_MS = 30 * 60 * 1000;

/** 客户端心跳超时：60 秒无消息则断开 */
const HEARTBEAT_TIMEOUT_MS = 60 * 1000;

export class RealtimeSession {
  private state: DurableObjectState;

  /** 客户端（浏览器）WebSocket */
  private clientWs: WebSocket | null = null;
  /** 豆包实时语音 API WebSocket */
  private doubaoWs: WebSocket | null = null;

  /** 会话是否已初始化（收到 SessionStarted） */
  private initialized = false;
  /** 会话开始时间 */
  private sessionStartTime = 0;
  /** 心跳计时器 */
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** 会话超时计时器 */
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;
  /** 会话 ID（UUID，用于二进制协议） */
  private sessionId = "";
  /** 面试配置（StartSession 需要） */
  private sessionConfig: DoubaoSessionConfig | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * DO 的 HTTP fetch 处理器
   */
  async fetch(request: Request): Promise<Response> {
    // 检查是否为 WebSocket 升级请求
    const upgradeHeader = request.headers.get("Upgrade");
    if (!upgradeHeader || upgradeHeader.toLowerCase() !== "websocket") {
      return new Response("Expected WebSocket upgrade", { status: 426 });
    }

    // 一个 DO 实例只服务一个客户端
    if (this.clientWs) {
      return new Response("Session already in use", { status: 409 });
    }

    // 提取会话配置（由 Worker 入口写入 URL 参数）
    const url = new URL(request.url);

    // 生成 session ID (UUID)
    this.sessionId = crypto.randomUUID();

    this.sessionConfig = {
      apiKey: url.searchParams.get("apiKey") || "",
      appId: url.searchParams.get("appId") || "",
      systemPrompt: url.searchParams.get("systemPrompt") || "",
      voice: url.searchParams.get("voice") || "",
      sessionId: this.sessionId,
    };

    // 创建 WebSocket pair（Cloudflare 特有 API）
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // server 端由 DO 管理
    this.state.acceptWebSocket(server);
    this.clientWs = server;

    // 初始化豆包连接
    this.initDoubaoConnection(this.sessionConfig);

    // 设置会话超时
    this.sessionStartTime = Date.now();
    this.sessionTimer = setTimeout(() => {
      this.endSession("会话超时（最大 30 分钟）");
    }, MAX_SESSION_DURATION_MS);

    // 重置心跳
    this.resetHeartbeat();

    // 返回客户端 WebSocket
    return new Response(null, {
      status: 101,
      webSocket: client,
    });
  }

  /**
   * 建立与豆包实时语音 API 的 WebSocket 连接
   *
   * CF Workers 不支持 `new WebSocket(url, {headers})`，
   * 必须使用 `fetch()` + `Upgrade: websocket` header 来建立出站 WebSocket。
   */
  private async initDoubaoConnection(config: DoubaoSessionConfig): Promise<void> {
    try {
      const connInfo = getDoubaoConnectionInfo(config);

      // CF Workers 建立出站 WebSocket 的标准方式
      const resp = await fetch(connInfo.url, {
        headers: {
          Upgrade: "websocket",
          ...connInfo.headers,
        },
      });

      const ws = resp.webSocket;
      if (!ws) {
        console.error("[Doubao] Failed to upgrade to WebSocket, status:", resp.status);
        this.sendToClient({
          type: "error",
          message: `语音模型连接失败 (HTTP ${resp.status})`,
        });
        this.endSession("豆包 WebSocket 升级失败");
        return;
      }

      // 接受服务端 WebSocket
      ws.accept();
      this.doubaoWs = ws;
      console.log("[Doubao] WebSocket connected");

      // 第一步：发送 StartConnection
      const startConnMsg = buildStartConnectionMessage();
      ws.send(startConnMsg);
      console.log("[Doubao] Sent StartConnection");

      ws.addEventListener("message", (event) => {
        this.handleDoubaoMessage(event);
      });

      ws.addEventListener("close", (event) => {
        console.log(
          `[Doubao] WebSocket closed: ${event.code} ${event.reason}`
        );
        this.endSession("豆包连接断开");
      });

      ws.addEventListener("error", (event) => {
        console.error("[Doubao] WebSocket error:", event);
        this.sendToClient({
          type: "error",
          message: "豆包语音连接异常",
        });
      });
    } catch (error) {
      console.error("[Doubao] Failed to connect:", error);
      this.sendToClient({
        type: "error",
        message: `无法连接到语音模型: ${error instanceof Error ? error.message : "未知错误"}`,
      });
      this.endSession("豆包连接失败");
    }
  }

  /**
   * 处理豆包返回的消息，解析二进制协议并透传给客户端
   */
  private handleDoubaoMessage(event: MessageEvent): void {
    let data: ArrayBuffer;

    if (event.data instanceof ArrayBuffer) {
      data = event.data;
    } else if (event.data instanceof Blob) {
      // Blob → ArrayBuffer（异步）
      event.data.arrayBuffer().then((buf) => {
        this.processDoubaoData(buf);
      });
      return;
    } else {
      // 字符串消息（不常见但需要处理）
      console.log("[Doubao] String message:", event.data);
      return;
    }

    this.processDoubaoData(data);
  }

  /**
   * 处理解析后的豆包数据
   */
  private processDoubaoData(data: ArrayBuffer): void {
    const parsed = parseDoubaoMessage(data);

    switch (parsed.type) {
      case "connection_started":
        // 连接建立成功，发送 StartSession
        console.log("[Doubao] ConnectionStarted, sending StartSession");
        if (this.doubaoWs && this.sessionConfig) {
          const startSessionMsg = buildStartSessionMessage(this.sessionConfig);
          this.doubaoWs.send(startSessionMsg);
          console.log("[Doubao] Sent StartSession with sessionId:", this.sessionId);
        }
        break;

      case "connection_failed":
        console.error("[Doubao] ConnectionFailed:", parsed.error);
        this.sendToClient({
          type: "error",
          message: `语音模型连接失败: ${parsed.error}`,
        });
        this.endSession("豆包连接失败");
        break;

      case "session_started":
        // 通知客户端连接就绪，可以开始说话
        this.initialized = true;
        console.log("[Doubao] SessionStarted, dialogId:", parsed.dialogId);
        this.sendToClient({
          type: "ready",
          sessionId: parsed.sessionId,
        });
        break;

      case "session_finished":
        this.endSession("面试结束");
        break;

      case "session_failed":
        console.error("[Doubao] SessionFailed:", parsed.error);
        this.sendToClient({
          type: "error",
          message: `会话失败: ${parsed.error}`,
        });
        this.endSession("豆包会话失败");
        break;

      case "audio":
        // 将二进制音频转为 base64 透传给客户端
        this.sendToClient({
          type: "audio",
          data: arrayBufferToBase64(parsed.data),
          mimeType: "audio/pcm;rate=24000",
        });
        break;

      case "tts_sentence_start":
        // TTS 开始合成一句话，包含文本
        if (parsed.text) {
          this.sendToClient({
            type: "transcript",
            role: "assistant",
            text: parsed.text,
          });
        }
        break;

      case "tts_ended":
        this.sendToClient({ type: "turnComplete" });
        break;

      case "asr_info":
        // 检测到用户开始说话，可用于打断播放
        this.sendToClient({ type: "userSpeaking" });
        break;

      case "asr_response":
        // 用户语音识别结果
        if (parsed.text) {
          this.sendToClient({
            type: "transcript",
            role: "user",
            text: parsed.text,
            isInterim: parsed.isInterim,
          });
        }
        break;

      case "asr_ended":
        // 用户说话结束
        break;

      case "chat_response":
        // LLM 文本响应
        if (parsed.text) {
          this.sendToClient({
            type: "transcript",
            role: "assistant",
            text: parsed.text,
          });
        }
        break;

      case "chat_ended":
        // 模型回复结束
        break;

      case "error":
        console.error(`[Doubao Error] ${parsed.code}: ${parsed.message}`);
        this.sendToClient({
          type: "error",
          message: `语音模型错误: ${parsed.message}`,
        });
        break;

      default:
        // 未知消息类型，忽略
        break;
    }
  }

  /**
   * Durable Object 的 WebSocket 消息处理器
   *
   * 当客户端通过 WebSocket 发送消息时，此方法被调用
   */
  webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): void {
    this.resetHeartbeat();

    if (typeof message !== "string") {
      return;
    }

    try {
      const data = JSON.parse(message);

      switch (data.type) {
        case "audio":
          // 客户端发送的 base64 音频数据，解码后用豆包二进制协议发送
          if (
            this.initialized &&
            this.doubaoWs?.readyState === WebSocket.OPEN
          ) {
            const pcmData = base64ToArrayBuffer(data.data);
            const binaryMsg = buildAudioMessage(pcmData, this.sessionId);
            this.doubaoWs.send(binaryMsg);
          }
          break;

        case "end":
          // 客户端主动结束面试
          if (this.doubaoWs?.readyState === WebSocket.OPEN) {
            const finishMsg = buildFinishSessionMessage(this.sessionId);
            this.doubaoWs.send(finishMsg);
          }
          this.endSession("用户主动结束");
          break;

        case "ping":
          this.sendToClient({ type: "pong" });
          break;

        default:
          console.log("[Client] Unknown message type:", data.type);
      }
    } catch (error) {
      console.error("[Client] Failed to parse message:", error);
    }
  }

  /**
   * Durable Object 的 WebSocket 关闭处理器
   */
  webSocketClose(
    ws: WebSocket,
    code: number,
    reason: string,
    wasClean: boolean
  ): void {
    console.log(`[Client] WebSocket closed: ${code} ${reason}`);
    this.cleanup();
  }

  /**
   * Durable Object 的 WebSocket 错误处理器
   */
  webSocketError(ws: WebSocket, error: unknown): void {
    console.error("[Client] WebSocket error:", error);
    this.cleanup();
  }

  /**
   * 向客户端发送 JSON 消息
   */
  private sendToClient(data: Record<string, unknown>): void {
    try {
      if (this.clientWs?.readyState === WebSocket.OPEN) {
        this.clientWs.send(JSON.stringify(data));
      }
    } catch (error) {
      console.error("[SendToClient] Failed:", error);
    }
  }

  /**
   * 重置心跳计时器
   */
  private resetHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
    }
    this.heartbeatTimer = setTimeout(() => {
      this.endSession("客户端心跳超时");
    }, HEARTBEAT_TIMEOUT_MS);
  }

  /**
   * 结束会话并通知客户端
   */
  private endSession(reason: string): void {
    console.log(`[Session] Ending: ${reason}`);
    this.sendToClient({
      type: "sessionEnd",
      reason,
      duration: Date.now() - this.sessionStartTime,
    });
    this.cleanup();
  }

  /**
   * 清理所有资源
   */
  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearTimeout(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    if (this.sessionTimer) {
      clearTimeout(this.sessionTimer);
      this.sessionTimer = null;
    }

    try {
      if (this.doubaoWs?.readyState === WebSocket.OPEN) {
        this.doubaoWs.close(1000, "Session ended");
      }
    } catch {
      /* ignore */
    }
    this.doubaoWs = null;

    try {
      if (this.clientWs?.readyState === WebSocket.OPEN) {
        this.clientWs.close(1000, "Session ended");
      }
    } catch {
      /* ignore */
    }
    this.clientWs = null;

    this.initialized = false;
    this.sessionConfig = null;
  }
}

// ===================== 工具函数 =====================

function base64ToArrayBuffer(base64: string): ArrayBuffer {
  const binaryString = atob(base64);
  const bytes = new Uint8Array(binaryString.length);
  for (let i = 0; i < binaryString.length; i++) {
    bytes[i] = binaryString.charCodeAt(i);
  }
  return bytes.buffer;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}
