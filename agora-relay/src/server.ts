/**
 * server.ts — Agora relay server entry point.
 *
 * Starts two servers:
 *   1. WebSocket relay  — RelayServer from @rookdaemon/agora on PORT (default 3001)
 *   2. REST API server  — Express on PORT+1 (default 3002)
 *
 * The two servers run on separate ports because RelayServer.start() creates and
 * owns its own WebSocketServer. The REST API is a separate Express server that
 * shares the same in-memory state (message buffer, session registry) via closure.
 *
 * Environment variables:
 *   PORT                     — WebSocket port (default: 3001); REST runs on PORT+1
 *   AGORA_RELAY_JWT_SECRET   — Secret for JWT signing (required)
 *   AGORA_JWT_EXPIRY_SECONDS — JWT expiry in seconds (default: 3600)
 */

import http from "node:http";
import express from "express";
import {
  RelayServer,
  createEnvelope,
  verifyEnvelope,
} from "@rookdaemon/agora";
import { createRestRouter, type RestSession } from "./rest-api.js";
import { MessageBuffer } from "./message-buffer.js";

async function main(): Promise<void> {
  const wsPort = parseInt(process.env.PORT ?? "3001", 10);
  const restPort = wsPort + 1;

  // Validate required env vars early
  if (!process.env.AGORA_RELAY_JWT_SECRET) {
    console.error(
      "Fatal: AGORA_RELAY_JWT_SECRET environment variable is required"
    );
    process.exit(1);
  }

  // Shared state
  const messageBuffer = new MessageBuffer();
  const restSessions = new Map<string, RestSession>();

  // WebSocket relay — binds its own WebSocketServer on wsPort
  const relay = new RelayServer();
  await relay.start(wsPort);

  // Express app for REST API — binds on restPort
  const app = express();
  app.use(express.json());

  const router = createRestRouter(
    relay,
    messageBuffer,
    restSessions,
    createEnvelope as Parameters<typeof createRestRouter>[3],
    verifyEnvelope as Parameters<typeof createRestRouter>[4]
  );
  app.use(router);

  // 404 handler — always return JSON, never HTML
  app.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  const httpServer = http.createServer(app);
  httpServer.listen(restPort, () => {
    console.log(`Agora relay WebSocket server running on ws://0.0.0.0:${wsPort}`);
    console.log(`Agora relay REST API running on http://0.0.0.0:${restPort}`);
  });

  // Graceful shutdown
  const shutdown = async (): Promise<void> => {
    console.log("Shutting down...");
    await relay.stop();
    httpServer.close();
    process.exit(0);
  };

  process.once("SIGTERM", () => void shutdown());
  process.once("SIGINT", () => void shutdown());
}

main().catch((err: unknown) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
