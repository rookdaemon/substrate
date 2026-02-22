import * as http from "node:http";
import { WebSocketServer, WebSocket } from "ws";
import { ILoopEventSink } from "./ILoopEventSink";
import { LoopEvent } from "./types";

const LOCALHOST_ORIGINS = ["localhost", "127.0.0.1", "::1"];

function isOriginAllowed(origin: string | undefined, allowlist: string[]): boolean {
  // Allow connections with no Origin header (e.g. CLI tools, curl)
  if (!origin) return true;
  // Empty allowlist: deny all browser-originated connections (only no-Origin clients allowed)
  if (allowlist.length === 0) return false;
  try {
    const host = new URL(origin).hostname;
    return allowlist.some((allowed) => host === allowed);
  } catch {
    return false;
  }
}

export class LoopWebSocketServer implements ILoopEventSink {
  private wss: WebSocketServer;

  /**
   * @param server - The underlying HTTP server to attach to.
   * @param allowedOrigins - Hostnames permitted to open WebSocket connections.
   *   Defaults to localhost/loopback only. Connections with no Origin header
   *   (e.g. CLI tools) are always allowed regardless of this list.
   */
  constructor(server: http.Server, allowedOrigins: string[] = LOCALHOST_ORIGINS) {
    this.wss = new WebSocketServer({
      server,
      verifyClient: ({ req }: { req: http.IncomingMessage }) => {
        const origin = req.headers["origin"] as string | undefined;
        return isOriginAllowed(origin, allowedOrigins);
      },
    });
  }

  emit(event: LoopEvent): void {
    const data = JSON.stringify(event);
    for (const client of this.wss.clients) {
      if (client.readyState === WebSocket.OPEN) {
        client.send(data);
      }
    }
  }

  close(): Promise<void> {
    return new Promise((resolve) => {
      this.wss.close(() => resolve());
    });
  }
}
