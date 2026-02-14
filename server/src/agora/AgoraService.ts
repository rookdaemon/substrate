import { readFile } from "fs/promises";
import { homedir } from "os";
import { join } from "path";

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

export interface AgoraConfig {
  identity: AgoraIdentity;
  peers: Map<string, PeerConfig>;
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

/**
 * AgoraService manages Agora protocol integration:
 * - Loading identity and peer registry
 * - Sending signed envelopes to peers via HTTP webhooks
 * - Decoding and verifying inbound envelopes
 */
export class AgoraService {
  private config: AgoraConfig;

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
      const result = agora.decodeInboundEnvelope(message, this.config.peers);

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

    return {
      identity: {
        publicKey: config.identity.publicKey,
        privateKey: config.identity.privateKey,
      },
      peers,
    };
  }
}
