<p align="center">
  <img src="https://img.shields.io/badge/Cloudflare-Workers-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Cloudflare Workers" />
  <img src="https://img.shields.io/badge/Durable-Objects-F38020?style=for-the-badge&logo=cloudflare&logoColor=white" alt="Durable Objects" />
  <img src="https://img.shields.io/badge/TypeScript-3178C6?style=for-the-badge&logo=typescript&logoColor=white" alt="TypeScript" />
  <img src="https://img.shields.io/badge/WebSocket-010101?style=for-the-badge&logo=socketdotio&logoColor=white" alt="WebSocket" />
</p>

# bole-server

> 🎙️ WebSocket proxy service for real-time voice interview — Cloudflare Workers + Durable Objects

**bole-server** 是 [伯乐Talk](https://www.bltalk.top) 项目的**实时语音面试代理服务**，基于 Cloudflare Workers 和 Durable Objects 构建。它在客户端浏览器与上游语音大模型 API 之间建立安全、低延时的 WebSocket 桥接，完成 JSON ↔ 二进制协议的双向转换，为端到端实时语音面试提供基础设施支撑。

## ✨ 特性

- 🔗 **双路 WebSocket 桥接** — 同时管理客户端连接与上游 AI 模型连接
- 🔒 **JWT 鉴权** — 通过 HMAC-SHA256 签名的 JWT Token 验证会话合法性
- 🎵 **二进制音频协议** — 实现火山引擎（豆包）自定义二进制帧协议的编解码
- 🌐 **多模型适配** — 支持豆包 Realtime API 和 Gemini Live API
- ⚡ **边缘部署** — 基于 Cloudflare 全球边缘网络，Smart Placement 智能选择最优节点
- 💓 **心跳保活 & 超时管理** — 60s 客户端心跳检测，30min 会话最大时长

## 🏗️ 架构

```
┌─────────────────┐        JSON/Base64         ┌─────────────────────────────────┐        Binary Protocol         ┌──────────────────┐
│                 │    (WebSocket: /ws/realtime) │          bole-server            │     (WebSocket: wss://...)     │                  │
│   Browser       │ ◄─────────────────────────► │  ┌─────────┐  ┌──────────────┐  │ ◄─────────────────────────────► │  Doubao / Gemini │
│   (Client)      │                             │  │ Worker   │─►│ DurableObject│  │                               │  Realtime API    │
│                 │                             │  │ (Router) │  │ (Session)    │  │                               │                  │
└─────────────────┘                             │  └─────────┘  └──────────────┘  │                               └──────────────────┘
                                                └─────────────────────────────────┘
```

### 请求流程

1. **前端**发起 WebSocket 升级请求 `ws://host/ws/realtime?token=<JWT>`
2. **Worker** 验证 JWT Token，提取 `sessionId`、`systemPrompt`、`model`、`voice` 等配置
3. **Worker** 将请求路由到对应的 **Durable Object** 实例（每个面试会话一个 DO）
4. **DO** 建立与上游语音 API（豆包/Gemini）的出站 WebSocket 连接
5. **双向透传**：客户端 Base64 PCM ↔ DO ↔ 上游二进制/JSON 协议

### 为什么用 Cloudflare Durable Objects？

| 痛点 | 解决方案 |
| :--- | :--- |
| 浏览器 `new WebSocket()` 不支持自定义 Header（无法传递 API Key）| DO 作为经过认证的代理，在 `fetch()` 出站连接中设置 Auth Header |
| 传统 Serverless（如阿里云 FC）为请求-响应模式，无法维持长连接 | DO 提供持久化、有状态的 WebSocket 生命周期管理 |
| 全球用户需要低延时 | Cloudflare 边缘网络 + Smart Placement 就近部署 |

## 📁 项目结构

```
src/
├── index.ts      # Worker 入口：路由、JWT 验证、CORS
├── session.ts    # RealtimeSession Durable Object：会话生命周期管理
├── doubao.ts     # 豆包 Realtime API：二进制帧协议编解码
└── gemini.ts     # Gemini Live API：JSON 协议适配
```

## 🔧 环境变量

| 变量 | 说明 | 配置方式 |
| :--- | :--- | :--- |
| `DOUBAO_API_KEY` | 豆包（火山引擎）API Key | `wrangler secret put` |
| `DOUBAO_APP_ID` | 豆包语音 App ID | `wrangler secret put` |
| `SESSION_SECRET` | JWT 签名密钥（与 boletalk-agent 保持一致） | `wrangler secret put` |

本地开发时，复制 `.dev.vars.example` 为 `.dev.vars` 并填入对应值。

## 🚀 快速开始

### 前置要求

- [Node.js](https://nodejs.org/) >= 18
- [Wrangler CLI](https://developers.cloudflare.com/workers/wrangler/) >= 3.x

### 本地开发

```bash
# 安装依赖
npm install

# 创建本地环境变量
cp .dev.vars.example .dev.vars
# 编辑 .dev.vars 填入实际的 API Key

# 启动本地开发服务器
npm run dev
```

### 部署

```bash
# 设置 Secrets（首次部署前）
wrangler secret put DOUBAO_API_KEY
wrangler secret put DOUBAO_APP_ID
wrangler secret put SESSION_SECRET

# 部署到 Cloudflare
npm run deploy
```

## 📡 WebSocket 协议

### 客户端 ↔ bole-server (JSON)

| 事件类型 | 方向 | 说明 |
| :--- | :--- | :--- |
| `ready` | Server → Client | AI 会话就绪，客户端可开始发送音频 |
| `audio` | 双向 | Base64 编码的 PCM 音频块（上行 16kHz / 下行 24kHz） |
| `transcript` | Server → Client | 最终确认的用户/AI 文本 |
| `transcript_update` | Server → Client | 中间 ASR 识别结果（实时更新 UI） |
| `transcript_delta` | Server → Client | LLM 增量文本片段（流式输出） |
| `turnComplete` | Server → Client | AI 当前轮次播报完毕 |
| `sessionEnd` | Server → Client | 会话关闭 |
| `ping` / `pong` | 双向 | 心跳保活 |
| `end` | Client → Server | 客户端主动结束面试 |

### bole-server ↔ 豆包 (Binary)

采用火山引擎自定义二进制帧协议：

```
[Header 4B] [EventID 4B] [SessionID_Size 4B] [SessionID] [Payload_Size 4B] [Payload]
```

- **音频输入**：PCM 16-bit, 16kHz, 单声道
- **音频输出**：PCM 16-bit, 24kHz, 单声道

## 📄 License