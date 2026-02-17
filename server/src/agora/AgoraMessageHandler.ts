import { IConversationManager } from "../conversation/IConversationManager";
import { IMessageInjector } from "../loop/IMessageInjector";
import { ILoopEventSink } from "../loop/ILoopEventSink";
import { IClock } from "../substrate/abstractions/IClock";
import { IAgoraService } from "./IAgoraService";
import { LoopState } from "../loop/types";
import { AgentRole } from "../agents/types";
import { shortKey } from "./utils";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import type { ILogger } from "../logging";

/**
 * AgoraMessageHandler - Handles inbound Agora messages
 * 
 * Responsibilities:
 * - Write messages to CONVERSATION.md
 * - Add [UNPROCESSED] markers when process is stopped/paused
 * - Inject messages directly into orchestrator (bypasses TinyBus)
 * - Emit WebSocket events for frontend visibility
 */
export class AgoraMessageHandler {
  constructor(
    private readonly agoraService: IAgoraService | null,
    private readonly conversationManager: IConversationManager,
    private readonly messageInjector: IMessageInjector,
    private readonly eventSink: ILoopEventSink | null,
    private readonly clock: IClock,
    private readonly getState: () => LoopState,
    private readonly isRateLimited: () => boolean = () => false,
    private readonly logger: ILogger
  ) {}

  /**
   * Resolve sender display name: try relay name hint first, then peer registry, fallback to short key
   * Returns format: "name...9f38f6d0" if name found, or "...9f38f6d0" if not found
   */
  private resolveSenderName(senderPublicKey: string, relayNameHint?: string): string {
    // Prefer relay name hint if provided (most up-to-date)
    if (relayNameHint) {
      return `${relayNameHint}...${shortKey(senderPublicKey).slice(3)}`; // Remove "..." prefix from shortKey
    }

    if (!this.agoraService) {
      return shortKey(senderPublicKey);
    }

    // Try to find peer name by matching public key in local registry
    const peers = this.agoraService.getPeers();
    for (const peerName of peers) {
      const peerConfig = this.agoraService.getPeerConfig(peerName);
      if (peerConfig && peerConfig.publicKey === senderPublicKey) {
        // Found matching peer - return name...shortKey format
        return `${peerName}...${shortKey(senderPublicKey).slice(3)}`; // Remove "..." prefix from shortKey
      }
    }

    // No matching peer found - return short key only
    return shortKey(senderPublicKey);
  }

  async processEnvelope(envelope: Envelope, source: "webhook" | "relay" = "webhook", relayNameHint?: string): Promise<void> {
    const timestamp = this.clock.now().toISOString();
    const senderDisplayName = this.resolveSenderName(envelope.sender, relayNameHint);
    const payloadStr = JSON.stringify(envelope.payload);

    this.logger.debug(`[AGORA] Received ${source} message: envelopeId=${envelope.id} type=${envelope.type} from=${senderDisplayName}`);

    // Determine if we should add [UNPROCESSED] marker
    // Check if effectively paused (explicitly paused OR rate-limited)
    const state = this.getState();
    const isUnprocessed = state === LoopState.STOPPED || state === LoopState.PAUSED || this.isRateLimited();

    if (isUnprocessed) {
      this.logger.debug(`[AGORA] Message marked as UNPROCESSED (state=${state}, rateLimited=${this.isRateLimited()})`);
    }

    // Format a user-friendly message (timestamp is added by AppendOnlyWriter, role by ConversationManager)
    // Try to format payload nicely if it's a simple object or string
    let formattedPayload = payloadStr;
    try {
      const parsed = JSON.parse(payloadStr);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        // If it's a simple object with readable fields, format it nicely
        const keys = Object.keys(parsed);
        if (keys.length <= 5 && keys.every(k => typeof parsed[k] === "string" || typeof parsed[k] === "number" || typeof parsed[k] === "boolean")) {
          formattedPayload = Object.entries(parsed)
            .map(([k, v]) => `**${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join("\n");
        } else {
          formattedPayload = JSON.stringify(parsed, null, 2);
        }
      }
    } catch {
      // If payload isn't valid JSON or is a string, use as-is
      formattedPayload = payloadStr;
    }

    const unprocessedBadge = isUnprocessed ? " **[UNPROCESSED]**" : "";
    // Simple format: sender name prominently, then message type, then content
    // Add invisible marker for provider detection (agora messages have short keys)
    const conversationEntry = `**${senderDisplayName}** (${envelope.type})${unprocessedBadge}\n\n${formattedPayload}`;

    // Write to CONVERSATION.md (using SUBCONSCIOUS role as it handles message processing)
    try {
      await this.conversationManager.append(AgentRole.SUBCONSCIOUS, conversationEntry);
      this.logger.debug(`[AGORA] Written to CONVERSATION.md: envelopeId=${envelope.id}`);
    } catch (err) {
      this.logger.debug(`[AGORA] Failed to write to CONVERSATION.md: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // Emit WebSocket event for frontend visibility
    if (this.eventSink) {
      try {
        this.eventSink.emit({
          type: "agora_message",
          timestamp,
          data: {
            envelopeId: envelope.id,
            messageType: envelope.type,
            sender: envelope.sender,
            payload: envelope.payload,
            source,
          },
        });
        this.logger.debug(`[AGORA] Emitted WebSocket event: envelopeId=${envelope.id}`);
      } catch (err) {
        this.logger.debug(`[AGORA] Failed to emit WebSocket event: ${err instanceof Error ? err.message : String(err)}`);
        // Don't throw - WebSocket emission failure shouldn't block message processing
      }
    } else {
      this.logger.debug(`[AGORA] No eventSink configured, skipping WebSocket event`);
    }

    // Inject message directly into orchestrator (bypass TinyBus)
    // Format message as agent prompt similar to old checkAgoraInbox format
    try {
      const agentPrompt = `[AGORA MESSAGE from ${senderDisplayName}]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nPayload: ${payloadStr}\n\nRespond to this message if appropriate. Use AgoraService.send() to reply.`;
      this.messageInjector.injectMessage(agentPrompt);
      this.logger.debug(`[AGORA] Injected message into orchestrator: envelopeId=${envelope.id}`);
    } catch (err) {
      this.logger.debug(`[AGORA] Failed to inject message into orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
