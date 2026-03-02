/**
 * RealtimeSession Durable Object
 *
 * 管理单个实时语音面试会话的完整生命周期：
 * 1. 接受客户端 WebSocket 连接
 * 2. 建立与 Gemini Live API 的 WebSocket 连接
 * 3. 双向透传音频数据
 * 4. 处理面试中断、超时等异常情况
 *
 * 使用 Durable Object 而不是普通 Worker 的原因：
 * - DO 可以持有 WebSocket 长连接不被回收
 * - DO 实例是有状态的，可以跟踪会话状态
 * - 每个面试会话对应一个 DO 实例，天然隔离
 */

import {
  type GeminiSessionConfig,
  buildAudioInputMessage,
  buildSetupMessage,
  connectToGemini,
  parseGeminiMessage,
} from "./gemini";

/** 面试会话最大时长：30 分钟 */
const MAX_SESSION_DURATION_MS = 30 * 60 * 1000;

/** 客户端心跳超时：60 秒无消息则断开 */
const HEARTBEAT_TIMEOUT_MS = 60 * 1000;

export class RealtimeSession {
  private state: DurableObjectState;

  /** 客户端（浏览器）WebSocket */
  private clientWs: WebSocket | null = null;
  /** Gemini Live API WebSocket */
  private geminiWs: WebSocket | null = null;

  /** 会话是否已初始化 */
  private initialized = false;
  /** 会话开始时间 */
  private sessionStartTime = 0;
  /** 心跳计时器 */
  private heartbeatTimer: ReturnType<typeof setTimeout> | null = null;
  /** 会话超时计时器 */
  private sessionTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(state: DurableObjectState) {
    this.state = state;
  }

  /**
   * DO 的 HTTP fetch 处理器
   *
   * 由 Worker 入口转发过来，这里处理 WebSocket 升级和音频透传
   */
  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);

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
    const config: GeminiSessionConfig = {
      apiKey: url.searchParams.get("apiKey") || "",
      model: url.searchParams.get("model") || "gemini-2.0-flash-live",
      systemPrompt: url.searchParams.get("systemPrompt") || "",
      voice: url.searchParams.get("voice") || "Aoede",
    };

    // 创建 WebSocket pair（Cloudflare 特有 API）
    const webSocketPair = new WebSocketPair();
    const [client, server] = Object.values(webSocketPair);

    // server 端由 DO 管理
    this.state.acceptWebSocket(server);
    this.clientWs = server;

    // 初始化 Gemini 连接
    this.initGeminiConnection(config);

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
   * 建立与 Gemini Live API 的 WebSocket 连接
   */
  private initGeminiConnection(config: GeminiSessionConfig): void {
    try {
      this.geminiWs = connectToGemini(config);

      this.geminiWs.addEventListener("open", () => {
        console.log("[Gemini] WebSocket connected");
        // 发送 setup 消息
        const setupMsg = buildSetupMessage(config);
        this.geminiWs?.send(setupMsg);
      });

      this.geminiWs.addEventListener("message", (event) => {
        this.handleGeminiMessage(event);
      });

      this.geminiWs.addEventListener("close", (event) => {
        console.log(
          `[Gemini] WebSocket closed: ${event.code} ${event.reason}`
        );
        this.endSession("Gemini 连接断开");
      });

      this.geminiWs.addEventListener("error", (event) => {
        console.error("[Gemini] WebSocket error:", event);
        this.sendToClient({
          type: "error",
          message: "Gemini 连接异常",
        });
      });
    } catch (error) {
      console.error("[Gemini] Failed to connect:", error);
      this.sendToClient({
        type: "error",
        message: "无法连接到语音模型",
      });
    }
  }

  /**
   * 处理 Gemini 返回的消息，透传给客户端
   */
  private handleGeminiMessage(event: MessageEvent): void {
    if (typeof event.data !== "string") {
      return;
    }

    const parsed = parseGeminiMessage(event.data);

    switch (parsed.type) {
      case "setupComplete":
        // 通知客户端连接就绪，可以开始说话
        this.initialized = true;
        this.sendToClient({ type: "ready" });
        break;

      case "audio":
        // 透传音频数据给客户端
        this.sendToClient({
          type: "audio",
          data: parsed.data,
          mimeType: parsed.mimeType,
        });
        break;

      case "text":
        // 透传文本（实时字幕/transcript）
        this.sendToClient({
          type: "transcript",
          role: "assistant",
          text: parsed.text,
        });
        break;

      case "turnComplete":
        // 模型说完一轮
        this.sendToClient({ type: "turnComplete" });
        break;

      case "interrupted":
        // 用户打断了模型
        this.sendToClient({ type: "interrupted" });
        break;

      default:
        // 未知消息类型，记录日志但不转发
        console.log("[Gemini] Unknown message:", parsed);
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
          // 客户端发送的音频数据，转发给 Gemini
          if (this.initialized && this.geminiWs?.readyState === WebSocket.OPEN) {
            const geminiMsg = buildAudioInputMessage(data.data);
            this.geminiWs.send(geminiMsg);
          }
          break;

        case "end":
          // 客户端主动结束面试
          this.endSession("用户主动结束");
          break;

        case "ping":
          // 心跳
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
   * 向客户端发送消息
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

    // 关闭 Gemini WebSocket
    try {
      if (this.geminiWs?.readyState === WebSocket.OPEN) {
        this.geminiWs.close(1000, "Session ended");
      }
    } catch {
      /* ignore */
    }
    this.geminiWs = null;

    // 关闭客户端 WebSocket
    try {
      if (this.clientWs?.readyState === WebSocket.OPEN) {
        this.clientWs.close(1000, "Session ended");
      }
    } catch {
      /* ignore */
    }
    this.clientWs = null;

    this.initialized = false;
  }
}
