import WebSocket from "ws";

const DOUBAO_WS_URL = "wss://openspeech.bytedance.com/api/v3/realtime/dialogue";

const APP_ID = process.env.DOUBAO_APP_ID;
const API_KEY = process.env.DOUBAO_API_KEY;

if (!APP_ID || !API_KEY) {
  console.error("Missing DOUBAO_APP_ID or DOUBAO_API_KEY");
  process.exit(1);
}

const headers = {
  "X-Api-App-ID": APP_ID,
  "X-Api-Access-Key": API_KEY, // OR `Bearer; ${API_KEY}`? We will test both.
  "X-Api-Resource-Id": "volc.speech.dialog",
  "X-Api-App-Key": "PlgvMymc7f3tQnJ6",
  "X-Api-Connect-Id": `bole-${Date.now()}`,
};

console.log("Connecting with headers:", { ...headers, "X-Api-Access-Key": "***" });

const ws = new WebSocket(DOUBAO_WS_URL, {
  headers,
});

ws.on("open", () => {
  console.log("Connected successfully!");
  
  // Try to send StartConnection
  const startConnBuf = Buffer.from([
    0x11, 0x14, 0x10, 0x00, 
    0x00, 0x00, 0x00, 0x01, 
    0x00, 0x00, 0x00, 0x02, 
    0x7b, 0x7d
  ]);
  ws.send(startConnBuf);
  console.log("Sent StartConnection");
});

ws.on("message", (data) => {
  console.log("Received data length:", data.length);
  // Just log the first few bytes
  console.log("Data hex:", data.toString('hex').substring(0, 40));
  ws.close();
});

ws.on("error", (error) => {
  console.error("WebSocket Error:");
  console.error(error);
});

ws.on("unexpected-response", (request, response) => {
  console.error(`Unexpected response: ${response.statusCode} ${response.statusMessage}`);
});

ws.on("close", (code, reason) => {
  console.log(`WebSocket closed: ${code} ${reason.toString()}`);
});
