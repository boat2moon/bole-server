/**
 * bole-server 入口模块
 *
 * Cloudflare Worker + Durable Objects 架构：
 * - Worker（本文件）：接收 HTTP/WebSocket 请求，路由到 Durable Object
 * - RealtimeSession（DO）：管理单个面试会话的 WebSocket 生命周期
 *
 * 请求流程：
 * 1. 前端发起 WebSocket 升级请求，携带 sessionToken
 * 2. Worker 验证 token，创建/获取 DO 实例
 * 3. DO 内部建立与豆包实时语音 API 的 WebSocket 连接
 * 4. 双向透传音频数据
 */

import { RealtimeSession } from "./session";

export { RealtimeSession };

export interface Env {
  REALTIME_SESSION: DurableObjectNamespace;
  DOUBAO_API_KEY: string;
  DOUBAO_APP_ID: string;
  SESSION_SECRET: string;
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    // 健康检查
    if (url.pathname === "/health") {
      return new Response(
        JSON.stringify({ status: "ok", service: "bole-server" }),
        { headers: { "Content-Type": "application/json" } }
      );
    }


    // WebSocket 升级请求
    if (url.pathname === "/ws/realtime") {
      return handleRealtimeWebSocket(request, env, url);
    }

    // CORS 预检
    if (request.method === "OPTIONS") {
      return new Response(null, {
        headers: corsHeaders(),
      });
    }

    return new Response("Not Found", { status: 404 });
  },
};

/**
 * 处理实时语音面试的 WebSocket 连接
 */
async function handleRealtimeWebSocket(
  request: Request,
  env: Env,
  url: URL
): Promise<Response> {
  // 1. 提取 sessionToken
  const token = url.searchParams.get("token");
  if (!token) {
    return new Response("Missing session token", { status: 401 });
  }

  // 2. 验证 token 并提取会话信息
  const sessionData = await verifySessionToken(token, env.SESSION_SECRET);
  if (!sessionData) {
    return new Response("Invalid or expired session token", { status: 401 });
  }

  // 3. 用 sessionId 获取/创建 Durable Object 实例
  const id = env.REALTIME_SESSION.idFromName(sessionData.sessionId);
  const stub = env.REALTIME_SESSION.get(id);

  // 4. 将请求转发给 DO，附带会话配置
  const doUrl = new URL(request.url);
  doUrl.searchParams.set("systemPrompt", sessionData.systemPrompt);
  doUrl.searchParams.set("model", sessionData.model);
  doUrl.searchParams.set("voice", sessionData.voice || "");
  const apiKey = (env.DOUBAO_API_KEY || "").trim();
  const appId = (env.DOUBAO_APP_ID || "").trim();
  
  console.log(`[Worker] passing secrets to DO. API_KEY length: ${apiKey.length}, APP_ID: ${appId}`);

  doUrl.searchParams.set("apiKey", apiKey);
  doUrl.searchParams.set("appId", appId);

  const doRequest = new Request(doUrl.toString(), request);
  return stub.fetch(doRequest);
}

/**
 * 验证 JWT session token
 *
 * Token 由 boletalk-agent 的 /api/realtime/session 签发
 * 包含：sessionId, systemPrompt, model, voice, exp
 */
async function verifySessionToken(
  token: string,
  secret: string
): Promise<SessionData | null> {
  try {
    // 简单的 JWT 验证（Base64URL 编码的 JSON + HMAC-SHA256 签名）
    const parts = token.split(".");
    if (parts.length !== 3) return null;

    const [headerB64, payloadB64, signatureB64] = parts;

    // 验证签名
    const key = await crypto.subtle.importKey(
      "raw",
      new TextEncoder().encode(secret),
      { name: "HMAC", hash: "SHA-256" },
      false,
      ["sign", "verify"]
    );

    const data = new TextEncoder().encode(`${headerB64}.${payloadB64}`);
    const signature = base64UrlDecode(signatureB64);

    const valid = await crypto.subtle.verify("HMAC", key, signature, data);
    if (!valid) return null;

    // 解析 payload
    const payload = JSON.parse(
      new TextDecoder().decode(base64UrlDecode(payloadB64))
    );

    // 检查过期时间
    if (payload.exp && Date.now() / 1000 > payload.exp) {
      return null;
    }

    return {
      sessionId: payload.sessionId,
      systemPrompt: payload.systemPrompt,
      model: payload.model,
      voice: payload.voice,
    };
  } catch {
    return null;
  }
}

interface SessionData {
  sessionId: string;
  systemPrompt: string;
  model: string;
  voice?: string;
}

function base64UrlDecode(str: string): Uint8Array {
  // 补齐 padding
  const padded = str + "=".repeat((4 - (str.length % 4)) % 4);
  const binary = atob(padded.replace(/-/g, "+").replace(/_/g, "/"));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function corsHeaders(): Record<string, string> {
  return {
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type, Authorization",
  };
}
