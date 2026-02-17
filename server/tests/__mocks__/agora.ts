export function shortKey(p: string): string { return p.slice(-8) + "..."; }
export interface Envelope { id: string; type: string; sender: string; timestamp: number; payload: unknown; signature: string; inReplyTo?: string; }
export interface AgoraServiceConfig { identity: { publicKey: string; privateKey: string; name?: string }; peers: Map<string, { publicKey: string; url: string; token: string }>; relay?: { url: string; autoConnect: boolean; name?: string; reconnectMaxMs?: number }; }
export type RelayMessageHandler = (e: Envelope) => void;
export interface Logger { debug(message: string): void; }
export interface RelayClientLike { connect(): Promise<void>; disconnect(): void; connected(): boolean; on(event: "message", h: (e: Envelope, from: string, fromName?: string) => void): void; on(event: "error", h: (err: Error) => void): void; }
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
  private relayMessageHandler: RelayMessageHandler | null = null;
  private logger: Logger | null = null;
  private relayClientFactory: RelayClientFactory | null = null;
  constructor(config: AgoraServiceConfig, logger?: Logger, relayClientFactory?: RelayClientFactory) { this.config = config; this.logger = logger ?? null; this.relayClientFactory = relayClientFactory ?? null; }
  async sendMessage(o: { peerName: string; type?: string; payload?: unknown; inReplyTo?: string }) { const p = this.config.peers.get(o.peerName); if (!p) return { ok: false, status: 0, error: "Unknown peer: " + o.peerName }; return { ok: true, status: 200 }; }
  async decodeInbound(m: string) { return { ok: false, reason: m.startsWith("[AGORA_ENVELOPE]") ? "invalid_base64" : "not_agora_message" }; }
  getPeers() { return Array.from(this.config.peers.keys()); }
  getPeerConfig(n: string) { return this.config.peers.get(n); }
  async connectRelay(url: string) {
    if (this.relayClient) return;
    const opts = { relayUrl: url, publicKey: this.config.identity.publicKey, privateKey: this.config.identity.privateKey, name: this.config.identity.name ?? this.config.relay?.name, pingInterval: 30000, maxReconnectDelay: this.config.relay?.reconnectMaxMs ?? 300000 };
    if (this.relayClientFactory) this.relayClient = this.relayClientFactory(opts);
    else throw new Error("factory required");
    this.relayClient.on("error", (err: Error) => { this.logger?.debug("Agora relay error: " + err.message); });
    this.relayClient.on("message", (e: Envelope) => { if (this.relayMessageHandler) this.relayMessageHandler(e); });
    try { await this.relayClient.connect(); } catch (e) { this.logger?.debug("Agora relay connect failed (" + url + "): " + (e instanceof Error ? e.message : String(e))); this.relayClient = null; }
  }
  setRelayMessageHandler(h: RelayMessageHandler) { this.relayMessageHandler = h; }
  async disconnectRelay() { if (this.relayClient) { this.relayClient.disconnect(); this.relayClient = null; } }
  isRelayConnected() { return this.relayClient?.connected() ?? false; }
  static async loadConfig() { throw new Error("not implemented"); }
}
