import { Message } from "../tinybus/core/Message";
import { Provider } from "../tinybus/core/Provider";
import { IAgoraService } from "./IAgoraService";
import { buildPeerReferenceDirectory, resolvePeerReference } from "./utils";
import type { SeenKeyStore } from "@rookdaemon/agora";
import type { ILogger } from "../logging";
import type { IConversationManager } from "../conversation/IConversationManager";
import type { IClock } from "../substrate/abstractions/IClock";
import { AgentRole } from "../agents/types";

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
    private readonly seenKeyStore?: SeenKeyStore | null,
    private readonly onSendFailed?: (peerName: string) => void,
    private readonly conversationManager?: IConversationManager | null,
    private readonly clock?: IClock,
  ) {}

  private isLikelyFullPublicKey(value: string): boolean {
    return /^[0-9a-fA-F]{16,}$/.test(value);
  }

  private formatOutboundPayload(payload: unknown): string {
    if (typeof payload === "string") return payload.slice(0, 500);
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const obj = payload as Record<string, unknown>;
      if (typeof obj.text === "string") return obj.text.slice(0, 500);
    }
    return JSON.stringify(payload).slice(0, 500);
  }

  // clock is always provided alongside conversationManager in production (injected from createLoopLayer).
  // Both are optional here to preserve backward-compat for callers that don't need conversation logging.
  private async logOutbound(recipients: string[], type: string, payload: unknown): Promise<void> {
    if (!this.conversationManager) return;
    try {
      const iso = this.clock?.now().toISOString() ?? "";
      const toList = recipients.join(", ");
      const text = this.formatOutboundPayload(payload);
      const entry = `[AGORA_OUT${iso ? ` ${iso}` : ""}] TO: ${toList} ${type}: ${text}`.replace(/\n+/g, " ").trim();
      await this.conversationManager.append(AgentRole.SUBCONSCIOUS, entry);
    } catch (err) {
      this.logger?.debug(`[AGORA-OUT] Failed to log outbound message to CONVERSATION.md: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

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

    const peerDirectory = buildPeerReferenceDirectory(this.agoraService, this.seenKeyStore ?? undefined);

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
      await this.logOutbound([payload.targetPubkey], payload.type, payload.payload);
      return;
    }

    // Multi-recipient send via the `to` list.
    // For in-reply-to flows, unknown recipients should still work via relay reply semantics.
    const resolvedTargets = (payload.to ?? []).map((ref) => ({
      original: ref,
      resolved: resolvePeerReference(ref, peerDirectory),
    }));
    if (resolvedTargets.length === 0) {
      throw new Error("Invalid agora.send payload: no recipients (provide to or targetPubkey)");
    }

    const sendTargets: string[] = [];
    const replyTargets: string[] = [];
    const unresolvedTargets: string[] = [];

    for (const target of resolvedTargets) {
      const isConfiguredPeer = !!this.agoraService.getPeerConfig(target.resolved);
      const isFullKey = this.isLikelyFullPublicKey(target.resolved);

      if (payload.inReplyTo && !isConfiguredPeer && isFullKey) {
        replyTargets.push(target.resolved);
      } else if (!isConfiguredPeer && !isFullKey) {
        unresolvedTargets.push(target.original);
      } else {
        sendTargets.push(target.resolved);
      }
    }

    if (unresolvedTargets.length > 0) {
      throw new Error(`Unresolved recipient reference(s): ${unresolvedTargets.join(", ")}`);
    }

    this.logger?.debug(
      `[AGORA-OUT] Sending: type=${payload.type} to ${resolvedTargets.length} recipient(s)` +
      (payload.inReplyTo ? ` inReplyTo=${payload.inReplyTo}` : "")
    );

    const errors: Array<{ recipient: string; error: string }> = [];

    // Build reverse map: resolved pubkey/name → original reference (for onSendFailed callbacks)
    const resolvedToOriginal = new Map<string, string>(
      resolvedTargets.map((t) => [t.resolved, t.original])
    );

    if (sendTargets.length > 0) {
      const sendResult = await this.agoraService.sendToAll({
        recipients: sendTargets,
        type: payload.type,
        payload: payload.payload,
        inReplyTo: payload.inReplyTo,
      });

      for (const err of sendResult.errors) {
        this.logger?.debug(`[AGORA-OUT] Failed to send to ${err.recipient}: ${err.error}`);
        const original = resolvedToOriginal.get(err.recipient) ?? err.recipient;
        this.onSendFailed?.(original);
      }
      errors.push(...sendResult.errors);
    }

    for (const targetPubkey of replyTargets) {
      const replyResult = await this.agoraService.replyToEnvelope({
        targetPubkey,
        type: payload.type,
        payload: payload.payload,
        inReplyTo: payload.inReplyTo!,
      });

      if (!replyResult.ok) {
        const error = replyResult.error ?? "unknown error";
        this.logger?.debug(`[AGORA-OUT] Failed reply to ${targetPubkey}: ${error}`);
        errors.push({ recipient: targetPubkey, error });
      }
    }

    const total = sendTargets.length + replyTargets.length;
    if (total > 0 && errors.length >= total) {
      throw new Error(`All sends failed: ${errors.map((e) => e.error).join("; ")}`);
    }

    await this.logOutbound(payload.to ?? [], payload.type, payload.payload);
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
