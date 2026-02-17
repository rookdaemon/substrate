import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

/**
 * Interface for Agora service operations.
 * Allows mocking Agora service operations in tests.
 */
export interface IAgoraService {
  sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }): Promise<{ ok: boolean; status: number; error?: string }>;
  decodeInbound(message: string): Promise<{ ok: boolean; envelope?: Envelope; reason?: string }>;
  getPeers(): string[];
  getPeerConfig(name: string): { publicKey: string; url: string; token: string } | undefined;
  connectRelay(url: string): Promise<void>;
  disconnectRelay(): Promise<void>;
  setRelayMessageHandler(handler: (envelope: Envelope) => void): void;
  isRelayConnected(): boolean;
}
