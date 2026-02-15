import WebSocket from "ws";
import type { Envelope } from "./AgoraService";

export interface RelayClientConfig {
  url: string;
  publicKey: string;
  reconnectMaxMs?: number;
}

export interface RelayMessageHandler {
  (envelope: Envelope): void;
}

/**
 * WebSocket client for connecting to Agora relay server.
 * Manages persistent connection with auto-reconnection and handles incoming messages.
 */
export class AgoraRelayClient {
  private ws: WebSocket | null = null;
  private config: RelayClientConfig;
  private reconnectDelay = 1000; // Start at 1 second
  private maxReconnectDelay: number;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private heartbeatTimer: NodeJS.Timeout | null = null;
  private isConnecting = false;
  private shouldReconnect = true;
  private messageHandler: RelayMessageHandler | null = null;
  private isRegistered = false;

  constructor(config: RelayClientConfig) {
    this.config = config;
    this.maxReconnectDelay = config.reconnectMaxMs ?? 300000; // Default 5 minutes
  }

  /**
   * Set handler for incoming messages from the relay
   */
  setMessageHandler(handler: RelayMessageHandler): void {
    this.messageHandler = handler;
  }

  /**
   * Connect to the relay server
   */
  async connect(): Promise<void> {
    if (this.ws || this.isConnecting) {
      return; // Already connected or connecting
    }

    this.isConnecting = true;
    this.shouldReconnect = true;

    return new Promise((resolve, reject) => {
      try {
        this.ws = new WebSocket(this.config.url);

        this.ws.on("open", () => {
          this.isConnecting = false;
          this.isRegistered = false;
          this.reconnectDelay = 1000; // Reset backoff on successful connection
          
          // Send registration message
          this.register();
          
          // Start heartbeat
          this.startHeartbeat();
        });

        this.ws.on("message", (data: WebSocket.Data) => {
          this.handleMessage(data);
        });

        this.ws.on("error", (error) => {
          this.isConnecting = false;
          // Don't reject here, let reconnection handle it
          console.error("Relay WebSocket error:", error.message);
        });

        this.ws.on("close", () => {
          this.isConnecting = false;
          this.isRegistered = false;
          this.cleanup();
          
          if (this.shouldReconnect) {
            this.scheduleReconnect();
          }
        });

        // Resolve once we start connecting (don't wait for registration)
        resolve();
      } catch (error) {
        this.isConnecting = false;
        reject(error);
      }
    });
  }

  /**
   * Disconnect from the relay server
   */
  async disconnect(): Promise<void> {
    this.shouldReconnect = false;
    
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    this.cleanup();
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }

  /**
   * Check if currently connected and registered
   */
  isConnected(): boolean {
    return this.ws !== null && this.ws.readyState === WebSocket.OPEN && this.isRegistered;
  }

  /**
   * Send a message envelope through the relay
   */
  async sendMessage(to: string, envelope: Envelope): Promise<{ ok: boolean; error?: string }> {
    if (!this.isConnected()) {
      return { ok: false, error: "Not connected to relay" };
    }

    try {
      const relayMsg = {
        type: "message",
        to,
        envelope,
      };
      this.ws!.send(JSON.stringify(relayMsg));
      return { ok: true };
    } catch (error) {
      return {
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Send registration message to relay
   */
  private register(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return;
    }

    const registerMsg = {
      type: "register",
      publicKey: this.config.publicKey,
    };
    this.ws.send(JSON.stringify(registerMsg));
  }

  /**
   * Handle incoming message from relay
   */
  private handleMessage(data: WebSocket.Data): void {
    try {
      const msg = JSON.parse(data.toString());

      if (msg.type === "registered") {
        this.isRegistered = true;
        return;
      }

      if (msg.type === "message" && msg.envelope) {
        // Incoming message routed through relay
        if (this.messageHandler) {
          this.messageHandler(msg.envelope as Envelope);
        }
        return;
      }

      if (msg.type === "error") {
        console.error("Relay server error:", msg.message);
        return;
      }

      if (msg.type === "pong") {
        // Heartbeat response - connection is alive
        return;
      }
    } catch (error) {
      console.error("Failed to parse relay message:", error);
    }
  }

  /**
   * Start heartbeat to keep connection alive
   */
  private startHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
    }

    // Send ping every 30 seconds
    this.heartbeatTimer = setInterval(() => {
      if (this.ws && this.ws.readyState === WebSocket.OPEN) {
        try {
          this.ws.send(JSON.stringify({ type: "ping" }));
        } catch (error) {
          console.error("Failed to send heartbeat:", error);
        }
      }
    }, 30000);
  }

  /**
   * Schedule reconnection with exponential backoff
   */
  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }

    const delay = Math.min(this.reconnectDelay, this.maxReconnectDelay);
    
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(() => {
        // Reconnection failed, will retry again
      });
    }, delay);

    // Exponential backoff: double the delay for next time
    this.reconnectDelay = Math.min(this.reconnectDelay * 2, this.maxReconnectDelay);
  }

  /**
   * Clean up timers and resources
   */
  private cleanup(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
  }
}
