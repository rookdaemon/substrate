import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

/**
 * Interface for Agora service operations.
 * Allows mocking Agora service operations in tests.
 */
export interface IAgoraService {
  sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string; allRecipients?: string[] }): Promise<{ ok: boolean; status: number; error?: string }>;
  /** Reply to any pubkey via relay — no peer config needed (RFC-002 Phase 1) */
  replyToEnvelope(options: { targetPubkey: string; type: string; payload: unknown; inReplyTo: string }): Promise<{ ok: boolean; status: number; error?: string }>;
  decodeInbound(message: string): Promise<{ ok: boolean; envelope?: Envelope; reason?: string }>;
  getPeers(): string[];
  getPeerConfig(name: string): { publicKey: string; url?: string; token?: string; name?: string } | undefined;
  connectRelay(url: string): Promise<void>;
  disconnectRelay(): Promise<void>;
  isRelayConnected(): boolean;
}
