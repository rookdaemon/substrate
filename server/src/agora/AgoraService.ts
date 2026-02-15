import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";
import { AgoraRelayClient } from "./AgoraRelayClient";

// Types for Agora - avoiding direct import due to ESM/CommonJS incompatibility
export type MessageType = 'announce' | 'discover' | 'request' | 'response' | 'publish' | 'subscribe' | 'verify' | 'ack' | 'error';
export interface Envelope<T = unknown> {
  id: string;
  type: MessageType;
  sender: string;
  timestamp: number;
  inReplyTo?: string;
  payload: T;
  signature: string;
}

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
 * - Loading identity and peer registry
 * - Sending signed envelopes to peers via HTTP webhooks
 * - Decoding and verifying inbound envelopes
 * - WebSocket relay client for remote peer communication
 */
export class AgoraService {
  private config: AgoraConfig;
  private relayClient: AgoraRelayClient | null = null;

  constructor(config: AgoraConfig) {
    this.config = config;
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
      // Dynamic import to avoid ESM/CommonJS issues
      const agora = await import("@rookdaemon/agora");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const result = await (agora.sendToPeer as any)(
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
      // Dynamic import to avoid ESM/CommonJS issues
      const agora = await import("@rookdaemon/agora");
      // decodeInboundEnvelope expects peers keyed by publicKey, not by name
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

  /**
   * Get list of configured peer names.
   */
  getPeers(): string[] {
    return Array.from(this.config.peers.keys());
  }

  /**
   * Get configuration for a specific peer.
   */
  getPeerConfig(name: string): PeerConfig | undefined {
    return this.config.peers.get(name);
  }

  /**
   * Connect to the relay server
   */
  async connectRelay(url: string): Promise<void> {
    if (this.relayClient) {
      return; // Already connected
    }

    this.relayClient = new AgoraRelayClient({
      url,
      publicKey: this.config.identity.publicKey,
      name: this.config.relay?.name,
      reconnectMaxMs: this.config.relay?.reconnectMaxMs,
    });

    await this.relayClient.connect();
  }

  /**
   * Set handler for incoming relay messages
   */
  setRelayMessageHandler(handler: RelayMessageHandler): void {
    if (this.relayClient) {
      this.relayClient.setMessageHandler(handler);
    }
  }

  /**
   * Disconnect from relay server
   */
  async disconnectRelay(): Promise<void> {
    if (this.relayClient) {
      await this.relayClient.disconnect();
      this.relayClient = null;
    }
  }

  /**
   * Check if relay is connected
   */
  isRelayConnected(): boolean {
    return this.relayClient?.isConnected() ?? false;
  }

  /**
   * Load Agora configuration from ~/.config/agora/config.json
   */
  static async loadConfig(): Promise<AgoraConfig> {
    const configPath = join(homedir(), ".config", "agora", "config.json");
    const configData = await readFile(configPath, "utf-8");
    const config = JSON.parse(configData);

    if (!config.identity || !config.identity.publicKey || !config.identity.privateKey) {
      throw new Error("Invalid Agora config: missing identity");
    }

    // Convert peers object to Map
    const peers = new Map<string, PeerConfig>();
    if (config.peers && typeof config.peers === "object") {
      for (const [name, peerData] of Object.entries(config.peers)) {
        const peer = peerData as { publicKey: string; url: string; token: string };
        if (peer.publicKey && peer.url && peer.token) {
          peers.set(name, {
            publicKey: peer.publicKey,
            url: peer.url,
            token: peer.token,
          });
        }
      }
    }

    // Parse relay configuration if present
    let relay: RelayConfig | undefined;
    if (config.relay && typeof config.relay === "object") {
      const relayData = config.relay as { url?: string; autoConnect?: boolean; name?: string; reconnectMaxMs?: number };
      if (relayData.url) {
        relay = {
          url: relayData.url,
          autoConnect: relayData.autoConnect ?? true,
          name: relayData.name,
          reconnectMaxMs: relayData.reconnectMaxMs,
        };
      }
    }

    return {
      identity: {
        publicKey: config.identity.publicKey,
        privateKey: config.identity.privateKey,
      },
      peers,
      relay,
    };
  }
}
