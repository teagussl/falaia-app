import express from "express";
import path from "path";
import http from "http";
import { WebSocketServer, WebSocket } from "ws";
import { GoogleGenAI, Modality } from "@google/genai";
import { createServer as createViteServer } from "vite";
import dotenv from "dotenv";

// Polyfill WebSocket for @google/genai SDK in Node.js environment
(global as any).WebSocket = WebSocket;

dotenv.config();

const app = express();
const PORT = 3000;
const server = http.createServer(app);
const wss = new WebSocketServer({ noServer: true });

// Setup Gemini Client with aistudio-build User-Agent for telemetry
const ai = new GoogleGenAI({
  apiKey: process.env.GEMINI_API_KEY,
  httpOptions: {
    headers: {
      'User-Agent': 'aistudio-build',
    }
  }
});

wss.on("connection", async (clientWs) => {
  console.log("New WebSocket client connected");

  try {
    const session = await ai.live.connect({
      model: "gemini-3.1-flash-live-preview",
      config: {
        responseModalities: [Modality.AUDIO],
        speechConfig: {
          voiceConfig: { prebuiltVoiceConfig: { voiceName: "Zephyr" } }, // Puck, Charon, Kore, Fenrir, Zephyr
        },
        systemInstruction: "Você é a Falaia, a assistente virtual do usuário. Apresente-se em português brasileiro como Falaia assim que a conversa iniciar. Você fala como uma amiga jovem, descolada e animada — usa gírias brasileiras naturais e uma vibe leve e bem-humorada, mas sem exagerar ou soar forçada. Você é curiosa e demonstra interesse genuíno pela pessoa. Ao responder, nunca dê respostas secas — sempre complemente com um comentário pessoal ou uma pergunta de volta, como faria uma amiga numa conversa de verdade. Você é acolhedora, tranquila, tem uma energia positiva e receptiva. Mantenha suas respostas curtas, pois esta é uma conversa por voz em tempo real. Habilite comportamentos de escuta ativa (reproduzindo sons de reconhecimento sutis e curtos como 'uhum', 'entendi', 'ah sim' de forma natural durante pausas ou enquanto o usuário fala, variando sua entonação de forma humana). Nunca mencione os nomes Gemini, Google, GPT ou qualquer nome de modelo de inteligência artificial subjacente. Responda sempre em português brasileiro.",
      },
      callbacks: {
        onmessage: (message) => {
          const parts = message.serverContent?.modelTurn?.parts;
          if (parts) {
            for (const part of parts) {
              if (part.inlineData?.data) {
                clientWs.send(JSON.stringify({ audio: part.inlineData.data }));
              }
            }
          }
          if (message.serverContent?.interrupted) {
            clientWs.send(JSON.stringify({ interrupted: true }));
          }
        },
      },
    });

    console.log("Connected to Gemini Live API");

    clientWs.on("message", (data) => {
      try {
        const parsed = JSON.parse(data.toString());
        if (parsed.audio) {
          session.sendRealtimeInput({
            audio: { data: parsed.audio, mimeType: "audio/pcm;rate=16000" },
          });
        }
      } catch (err) {
        console.error("Error parsing client message:", err);
      }
    });

    clientWs.on("close", () => {
      console.log("Client closed connection, closing Gemini session");
      try {
        session.close();
      } catch (err) {
        console.error("Error closing Gemini session:", err);
      }
    });

    clientWs.on("error", (err) => {
      console.error("Client WS error:", err);
      try {
        session.close();
      } catch (err2) {
        console.error("Error closing Gemini session:", err2);
      }
    });

  } catch (err) {
    console.error("Failed to connect to Gemini Live API:", err);
    clientWs.send(JSON.stringify({ error: "Failed to connect to Gemini Live API" }));
    clientWs.close();
  }
});

// Route upgrades to WebSocket server
server.on("upgrade", (request, socket, head) => {
  const { pathname } = new URL(request.url || "", "http://localhost");
  if (pathname === "/live") {
    wss.handleUpgrade(request, socket, head, (ws) => {
      wss.emit("connection", ws, request);
    });
  } else {
    socket.destroy();
  }
});

// API routes
app.get("/api/health", (req, res) => {
  res.json({ status: "ok" });
});

async function startServer() {
  if (process.env.NODE_ENV !== "production") {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req, res) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, "0.0.0.0", () => {
    console.log(`Server running on port ${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start server:", err);
});
