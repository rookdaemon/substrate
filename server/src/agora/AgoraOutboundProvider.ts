import { Message } from "../tinybus/core/Message";
import { Provider } from "../tinybus/core/Provider";
import { IAgoraService } from "./IAgoraService";
import { buildPeerReferenceDirectory, resolvePeerReference } from "./utils";
import type { ILogger } from "../logging";

/**
 * AgoraOutboundProvider - Handles outbound Agora messages via TinyBus
 *
 * Implements TinyBus Provider interface but lives in agora/ module
 * to maintain separation of concerns (all Agora code in one place).
 *
 * Expected message format:
 * - type: "agora.send"
 * - payload: { to?: string[]; targetPubkey?: string; type: string; payload: unknown; inReplyTo?: string }
 *
 * Routing priority:
 * 1. targetPubkey: reply via relay to any pubkey (RFC-002 Phase 1, requires inReplyTo)
 * 2. to: send to each listed recipient (names, short refs, or full keys are expanded)
 * Partial failures are logged but don't throw unless ALL sends fail.
 */
export class AgoraOutboundProvider implements Provider {
  public readonly id = "agora";
  private ready = false;
  private started = false;

  constructor(
    private readonly agoraService: IAgoraService | null,
    private readonly logger?: ILogger,
  ) {}

  async isReady(): Promise<boolean> {
    return this.ready && this.agoraService !== null;
  }

  async start(): Promise<void> {
    this.started = true;
    // Only mark ready if Agora service is configured
    this.ready = this.agoraService !== null;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ready = false;
    // Disconnect relay if connected
    if (this.agoraService?.isRelayConnected()) {
      await this.agoraService.disconnectRelay();
    }
  }

  /**
   * Send outbound messages from TinyBus to Agora peers
   */
  async send(message: Message): Promise<void> {
    if (!this.started) {
      throw new Error(`Provider ${this.id} not started`);
    }

    if (!this.agoraService) {
      throw new Error("Agora service not configured");
    }

    // Only handle agora.send messages
    if (message.type !== "agora.send") {
      return;
    }

    // Defensively parse payload if the model passed it as a JSON string.
    const raw = typeof message.payload === "string"
      ? (() => { try { return JSON.parse(message.payload as string); } catch { return null; } })()
      : message.payload;

    const payload = raw as {
      to?: string[];
      targetPubkey?: string;
      type: string;
      payload: unknown;
      inReplyTo?: string;
    };

    const peerDirectory = buildPeerReferenceDirectory(this.agoraService);

    if (!payload?.type) {
      throw new Error("Invalid agora.send payload: missing type");
    }

    // RFC-002 Phase 1: reply to any pubkey via relay (no peer config needed)
    if (payload.targetPubkey) {
      if (!payload.inReplyTo) {
        throw new Error("Invalid agora.send payload: targetPubkey requires inReplyTo");
      }
      const targetPubkey = resolvePeerReference(payload.targetPubkey, peerDirectory);
      this.logger?.debug(
        `[AGORA-OUT] Replying to pubkey: ${targetPubkey} type=${payload.type} inReplyTo=${payload.inReplyTo}`
      );
      const result = await this.agoraService.replyToEnvelope({
        targetPubkey,
        type: payload.type,
        payload: payload.payload,
        inReplyTo: payload.inReplyTo,
      });
      if (!result.ok) {
        throw new Error(`Reply to pubkey failed: ${result.error ?? "unknown error"} (status=${result.status})`);
      }
      this.logger?.debug(
        `[AGORA-OUT] Reply sent successfully: ${targetPubkey}`
      );
      return;
    }

    // Multi-recipient send via the `to` list
    const targets = (payload.to ?? []).map((ref) => resolvePeerReference(ref, peerDirectory));
    if (targets.length === 0) {
      throw new Error("Invalid agora.send payload: no recipients (provide to or targetPubkey)");
    }

    this.logger?.debug(
      `[AGORA-OUT] Sending: type=${payload.type} to ${targets.length} recipient(s)` +
      (payload.inReplyTo ? ` inReplyTo=${payload.inReplyTo}` : "")
    );

    const result = await this.agoraService.sendToAll({
      recipients: targets,
      type: payload.type,
      payload: payload.payload,
      inReplyTo: payload.inReplyTo,
    });

    for (const err of result.errors) {
      this.logger?.debug(`[AGORA-OUT] Failed to send to ${err.recipient}: ${err.error}`);
    }

    if (!result.ok) {
      throw new Error(`All sends failed: ${result.errors.map((e: { error: string }) => e.error).join("; ")}`);
    }
  }

  onMessage(_handler: (message: Message) => Promise<void>): void {
    // Not used for outbound provider
  }

  /**
   * Get message types this provider handles
   */
  getMessageTypes(): string[] {
    return ["agora.send"];
  }
}
