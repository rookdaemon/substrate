export function shortKey(p: string): string { return p.slice(-8) + "..."; }
import { join } from "node:path";

export const IGNORED_FILE_NAME = "IGNORED_PEERS.md";
export const SEEN_KEYS_FILE_NAME = "seen-keys.json";

export function getIgnoredPeersPath(storageDir?: string): string {
  if (storageDir) {
    return join(storageDir, IGNORED_FILE_NAME);
  }
  return join(process.cwd(), IGNORED_FILE_NAME);
}

export function getSeenKeysPath(storageDir?: string): string {
  if (storageDir) {
    return join(storageDir, SEEN_KEYS_FILE_NAME);
  }
  return join(process.cwd(), SEEN_KEYS_FILE_NAME);
}

/** In-memory only — no real filesystem access. */
export class IgnoredPeersManager {
  private readonly peers: Set<string> = new Set();

  constructor(_filePath?: string) {
    // In-memory mock — does not read from or write to any file.
  }

  ignorePeer(publicKey: string): boolean {
    const normalized = publicKey.trim();
    if (!normalized) return false;
    const added = !this.peers.has(normalized);
    this.peers.add(normalized);
    return added;
  }

  unignorePeer(publicKey: string): boolean {
    const normalized = publicKey.trim();
    const removed = this.peers.delete(normalized);
    return removed;
  }

  listIgnoredPeers(): string[] {
    return Array.from(this.peers.values()).sort();
  }
}

export class SeenKeyStore {
  private keys: Map<string, { publicKey: string; firstSeen: number; lastSeen: number; seenCount: number }> = new Map();

  constructor(private readonly filePath: string) {}

  record(publicKey: string): void {
    const now = Date.now();
    const existing = this.keys.get(publicKey);
    if (existing) {
      existing.lastSeen = now;
      existing.seenCount++;
    } else {
      this.keys.set(publicKey, { publicKey, firstSeen: now, lastSeen: now, seenCount: 1 });
    }
  }

  has(publicKey: string): boolean { return this.keys.has(publicKey); }
  get(publicKey: string) { return this.keys.get(publicKey); }
  getAll() { return Array.from(this.keys.values()); }
  toReferenceEntries() { return Array.from(this.keys.values()).map((e: { publicKey: string }) => ({ publicKey: e.publicKey })); }
  flush(): void { /* no-op in mock */ }
}

export interface Envelope { id: string; type: string; sender: string; timestamp: number; payload: unknown; signature: string; inReplyTo?: string; }
export interface AgoraServiceConfig { identity: { publicKey: string; privateKey: string; name?: string }; peers: Map<string, { publicKey: string; url: string; token: string }>; relay?: { url: string; autoConnect: boolean; name?: string; reconnectMaxMs?: number }; }
export type RelayMessageHandler = (e: Envelope) => void;
export interface Logger { debug(message: string): void; }
export interface RelayClientLike { connect(): Promise<void>; disconnect(): void; connected(): boolean; on(event: "message", h: (e: Envelope, from: string) => void): void; on(event: "error", h: (err: Error) => void): void; }
export type RelayClientFactory = (opts: object) => RelayClientLike;

/**
 * Create a properly signed envelope for testing.
 * This is a mock implementation that generates valid signatures.
 */
export function createEnvelope<T>(
  type: string,
  sender: string,
  _privateKey: string, // Unused in mock but kept for API compatibility
  payload: T,
  timestamp: number = Date.now(),
  inReplyTo?: string
): Envelope {
  // Create a mock ID (real implementation would hash the canonical representation)
  const id = `id-${Math.random().toString(36).substring(7)}`;
  
  // Generate a mock signature (in real implementation this would use Ed25519)
  const signature = `sig-${sender.slice(-16)}-${timestamp}`;
  
  return {
    id,
    type,
    sender,
    timestamp,
    payload,
    signature,
    ...(inReplyTo && { inReplyTo }),
  };
}

/**
 * Verify an envelope's signature.
 * This is a mock implementation for testing.
 */
export function verifyEnvelope(envelope: Envelope): { valid: boolean; reason?: string } {
  if (!envelope.signature || envelope.signature.length === 0) {
    return { valid: false, reason: "missing signature" };
  }
  
  // Check if signature matches the expected pattern from createEnvelope
  if (envelope.signature.startsWith("sig-") || envelope.signature.startsWith("test-signature")) {
    return { valid: true };
  }
  
  // Invalid signature format
  return { valid: false, reason: "invalid signature format" };
}

export class AgoraService {
  private config: AgoraServiceConfig;
  private relayClient: RelayClientLike | null = null;
  private onRelayMessage: ((e: Envelope, from: string) => void) | null = null;
  private logger: Logger | null = null;
  private relayClientFactory: RelayClientFactory | null = null;
  constructor(config: AgoraServiceConfig, onRelayMessage?: ((e: Envelope, from: string) => void) | Logger, logger?: Logger | RelayClientFactory, relayClientFactory?: RelayClientFactory) {
    this.config = config;
    if (typeof onRelayMessage === "function") {
      this.onRelayMessage = onRelayMessage;
      this.logger = (logger as Logger) ?? null;
      this.relayClientFactory = relayClientFactory ?? null;
    } else {
      // legacy: (config, logger?, relayClientFactory?)
      this.logger = (onRelayMessage as Logger) ?? null;
      this.relayClientFactory = (logger as RelayClientFactory) ?? null;
    }
  }
  async sendMessage(o: { peerName: string; type?: string; payload?: unknown; inReplyTo?: string }) { const p = this.config.peers.get(o.peerName); if (!p) return { ok: false, status: 0, error: "Unknown peer: " + o.peerName }; return { ok: true, status: 200 }; }
  async replyToEnvelope(_o: { targetPubkey: string; type: string; payload: unknown; inReplyTo: string }) { return { ok: true, status: 200 }; }
  async decodeInbound(m: string) { return { ok: false, reason: m.startsWith("[AGORA_ENVELOPE]") ? "invalid_base64" : "not_agora_message" }; }
  getPeers() { return Array.from(this.config.peers.keys()); }
  getPeerConfig(n: string) { return this.config.peers.get(n); }
  getSelfIdentity() { return { publicKey: this.config.identity.publicKey, name: this.config.identity.name }; }
  async connectRelay(url: string) {
    if (this.relayClient) return;
    const opts = { relayUrl: url, publicKey: this.config.identity.publicKey, privateKey: this.config.identity.privateKey, name: this.config.identity.name ?? this.config.relay?.name, pingInterval: 30000, maxReconnectDelay: this.config.relay?.reconnectMaxMs ?? 300000 };
    if (this.relayClientFactory) this.relayClient = this.relayClientFactory(opts);
    else throw new Error("factory required");
    this.relayClient.on("error", (err: Error) => { this.logger?.debug("Agora relay error: " + err.message); });
    this.relayClient.on("message", (e: Envelope, from: string) => { this.onRelayMessage?.(e, from); });
    try { await this.relayClient.connect(); } catch (e) { this.logger?.debug("Agora relay connect failed (" + url + "): " + (e instanceof Error ? e.message : String(e))); this.relayClient = null; }
  }
  async disconnectRelay() { if (this.relayClient) { this.relayClient.disconnect(); this.relayClient = null; } }
  isRelayConnected() { return this.relayClient?.connected() ?? false; }
  static async loadConfig() { throw new Error("not implemented"); }
}
