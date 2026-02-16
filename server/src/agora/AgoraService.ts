import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

// Re-export Envelope for consumers that import from AgoraService
export type { Envelope };

/** Minimal type for @rookdaemon/agora RelayClient (used at runtime via dynamic import) */
export interface RelayClientLike {
  connect(): Promise<void>;
  disconnect(): void;
  connected(): boolean;
  on(event: "message", handler: (envelope: Envelope, from: string, fromName?: string) => void): void;
  on(event: "error", handler: (error: Error) => void): void;
}

export interface RelayClientFactory {
  (opts: {
    relayUrl: string;
    publicKey: string;
    privateKey: string;
    name?: string;
    pingInterval: number;
    maxReconnectDelay: number;
  }): RelayClientLike;
}

export type MessageType =
  | "announce"
  | "discover"
  | "request"
  | "response"
  | "publish"
  | "subscribe"
  | "verify"
  | "ack"
  | "error";

export interface AgoraIdentity {
  publicKey: string;
  privateKey: string;
}

export interface PeerConfig {
  publicKey: string;
  url: string;
  token: string;
}

export interface RelayConfig {
  url: string;
  autoConnect: boolean;
  name?: string;
  reconnectMaxMs?: number;
}

export interface AgoraConfig {
  identity: AgoraIdentity;
  peers: Map<string, PeerConfig>;
  relay?: RelayConfig;
}

export interface SendMessageOptions {
  peerName: string;
  type: MessageType;
  payload: unknown;
  inReplyTo?: string;
}

export interface SendMessageResult {
  ok: boolean;
  status: number;
  error?: string;
}

export interface DecodeInboundResult {
  ok: boolean;
  envelope?: Envelope;
  reason?: string;
}

export interface RelayMessageHandler {
  (envelope: Envelope): void;
}

/**
 * AgoraService manages Agora protocol integration:
 * - Loading identity and peer registry (via @rookdaemon/agora loadAgoraConfig when available)
 * - Sending signed envelopes to peers via HTTP webhooks
 * - Decoding and verifying inbound envelopes
 * - WebSocket relay client from @rookdaemon/agora for remote peer communication
 */
export interface Logger {
  debug(message: string): void;
}

export class AgoraService {
  private config: AgoraConfig;
  private relayClient: RelayClientLike | null = null;
  private relayMessageHandler: RelayMessageHandler | null = null;
  private logger: Logger | null;
  private relayClientFactory: RelayClientFactory | null;

  constructor(config: AgoraConfig, logger?: Logger, relayClientFactory?: RelayClientFactory) {
    this.config = config;
    this.logger = logger ?? null;
    this.relayClientFactory = relayClientFactory ?? null;
  }

  /**
   * Send a signed message to a named peer.
   * The peer must exist in the configured peer registry.
   */
  async sendMessage(options: SendMessageOptions): Promise<SendMessageResult> {
    const peer = this.config.peers.get(options.peerName);
    if (!peer) {
      return {
        ok: false,
        status: 0,
        error: `Unknown peer: ${options.peerName}`,
      };
    }

    try {
      const agora = await import("@rookdaemon/agora");
      const result = await (agora.sendToPeer as (
        config: { identity: AgoraIdentity; peers: Map<string, PeerConfig> },
        peerPublicKey: string,
        type: string,
        payload: unknown,
        inReplyTo?: string
      ) => Promise<SendMessageResult>)(
        {
          identity: this.config.identity,
          peers: this.config.peers,
        },
        peer.publicKey,
        options.type,
        options.payload,
        options.inReplyTo
      );

      return result;
    } catch (error) {
      return {
        ok: false,
        status: 0,
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  /**
   * Decode and verify an inbound envelope from a webhook message.
   * Expected format: "[AGORA_ENVELOPE]base64url-encoded-envelope"
   */
  async decodeInbound(message: string): Promise<DecodeInboundResult> {
    try {
      const agora = await import("@rookdaemon/agora");
      const peersByPubKey = new Map<string, PeerConfig>();
      for (const [, peer] of this.config.peers) {
        peersByPubKey.set(peer.publicKey, peer);
      }
      const result = agora.decodeInboundEnvelope(message, peersByPubKey);

      if (result.ok) {
        return {
          ok: true,
          envelope: result.envelope,
        };
      } else {
        return {
          ok: false,
          reason: result.reason,
        };
      }
    } catch (error) {
      return {
        ok: false,
        reason: error instanceof Error ? error.message : String(error),
      };
    }
  }

  getPeers(): string[] {
    return Array.from(this.config.peers.keys());
  }

  getPeerConfig(name: string): PeerConfig | undefined {
    return this.config.peers.get(name);
  }

  /**
   * Connect to the relay server using @rookdaemon/agora RelayClient.
   * Errors are logged and swallowed so a relay outage never crashes the process.
   */
  async connectRelay(url: string): Promise<void> {
    if (this.relayClient) {
      return;
    }

    const maxReconnectDelay = this.config.relay?.reconnectMaxMs ?? 300000;
    const opts = {
      relayUrl: url,
      publicKey: this.config.identity.publicKey,
      privateKey: this.config.identity.privateKey,
      name: this.config.relay?.name,
      pingInterval: 30000,
      maxReconnectDelay,
    };

    if (this.relayClientFactory) {
      this.relayClient = this.relayClientFactory(opts);
    } else {
      const { RelayClient } = await import("@rookdaemon/agora");
      this.relayClient = new RelayClient(opts);
    }

    // Attach error handler BEFORE connect() so EventEmitter never throws uncaught
    this.relayClient.on("error", (error: Error) => {
      this.logger?.debug(`Agora relay error: ${error.message}`);
    });

    this.relayClient.on("message", (envelope: Envelope) => {
      if (this.relayMessageHandler) {
        this.relayMessageHandler(envelope);
      }
    });

    try {
      await this.relayClient.connect();
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger?.debug(`Agora relay connect failed (${url}): ${message}`);
      this.relayClient = null;
    }
  }

  setRelayMessageHandler(handler: RelayMessageHandler): void {
    this.relayMessageHandler = handler;
  }

  async disconnectRelay(): Promise<void> {
    if (this.relayClient) {
      this.relayClient.disconnect();
      this.relayClient = null;
    }
  }

  isRelayConnected(): boolean {
    return this.relayClient?.connected() ?? false;
  }

  /**
   * Load Agora configuration from ~/.config/agora/config.json.
   * Uses @rookdaemon/agora loadAgoraConfig when available for canonical parsing.
   */
  static async loadConfig(): Promise<AgoraConfig> {
    try {
      const agora = await import("@rookdaemon/agora");
      if (typeof agora.loadAgoraConfig === "function") {
        const loaded = agora.loadAgoraConfig();
        const peers = new Map<string, PeerConfig>();
        for (const [name, peer] of Object.entries(loaded.peers)) {
          peers.set(name, peer);
        }
        return {
          identity: loaded.identity,
          peers,
          relay: loaded.relay,
        };
      }
    } catch {
      // Fall back to local parsing if agora doesn't export loadAgoraConfig (e.g. older version)
    }

    const { readFile } = await import("fs/promises");
    const { homedir } = await import("os");
    const { join } = await import("path");
    const configPath = join(homedir(), ".config", "agora", "config.json");
    const configData = await readFile(configPath, "utf-8");
    const config = JSON.parse(configData) as {
      identity?: { publicKey: string; privateKey: string };
      peers?: Record<string, { publicKey: string; url: string; token: string }>;
      relay?: { url?: string; autoConnect?: boolean; name?: string; reconnectMaxMs?: number };
    };

    if (!config.identity?.publicKey || !config.identity?.privateKey) {
      throw new Error("Invalid Agora config: missing identity");
    }

    const peers = new Map<string, PeerConfig>();
    if (config.peers && typeof config.peers === "object") {
      for (const [name, peerData] of Object.entries(config.peers)) {
        if (peerData?.publicKey && peerData?.url && peerData?.token) {
          peers.set(name, {
            publicKey: peerData.publicKey,
            url: peerData.url,
            token: peerData.token,
          });
        }
      }
    }

    let relay: RelayConfig | undefined;
    if (config.relay && typeof config.relay === "object" && config.relay.url) {
      relay = {
        url: config.relay.url,
        autoConnect: config.relay.autoConnect ?? true,
        name: config.relay.name,
        reconnectMaxMs: config.relay.reconnectMaxMs,
      };
    }

    return {
      identity: config.identity,
      peers,
      relay,
    };
  }
}
