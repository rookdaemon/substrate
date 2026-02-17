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
 * - Deduplicate envelopes to prevent replay attacks
 */
export class AgoraMessageHandler {
  private processedEnvelopeIds: Set<string> = new Set();
  private readonly MAX_DEDUP_SIZE = 1000;

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
   * Check if an envelope ID has already been processed.
   * Returns true if duplicate, false if new.
   * Maintains a bounded set with oldest-first eviction when MAX_DEDUP_SIZE is exceeded.
   */
  private isDuplicate(envelopeId: string): boolean {
    if (this.processedEnvelopeIds.has(envelopeId)) {
      this.logger.debug(`[AGORA] Duplicate envelope ${envelopeId} — skipping`);
      return true;
    }
    
    // Add to set
    this.processedEnvelopeIds.add(envelopeId);
    
    // Bound size: if over limit, remove oldest entry
    if (this.processedEnvelopeIds.size > this.MAX_DEDUP_SIZE) {
      const oldest = this.processedEnvelopeIds.values().next().value;
      if (oldest !== undefined) {
        this.processedEnvelopeIds.delete(oldest);
      }
    }
    
    return false;
  }

  /**
   * Resolve sender display name: try relay name hint first, then peer registry, fallback to short key
   * Returns format: "name...9f38f6d0" if name found, or "...9f38f6d0" if not found
   */
  private resolveSenderName(senderPublicKey: string, relayNameHint?: string): string {
    const keySuffix = shortKey(senderPublicKey);
    // Prefer relay name hint if provided (most up-to-date), unless it's just the short key (avoid "...9f38f6d0...9f38f6d0")
    if (relayNameHint && relayNameHint !== keySuffix && !/^\.\.\.[a-f0-9]{8}$/i.test(relayNameHint.trim())) {
      return `${relayNameHint}...${keySuffix.slice(3)}`; // Remove "..." prefix from shortKey
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
    // Check for duplicate envelope ID early - return without processing if duplicate
    if (this.isDuplicate(envelope.id)) {
      return;
    }

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
        const keys = Object.keys(parsed);
        if (keys.length === 1 && keys[0] === "text" && typeof parsed.text === "string") {
          formattedPayload = parsed.text;
        } else if (keys.length <= 5 && keys.every(k => typeof parsed[k] === "string" || typeof parsed[k] === "number" || typeof parsed[k] === "boolean")) {
          formattedPayload = Object.entries(parsed)
            .map(([k, v]) => `**${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(", ");
        } else {
          formattedPayload = JSON.stringify(parsed, null, 2);
        }
      }
    } catch {
      formattedPayload = payloadStr;
    }

    const unprocessedBadge = isUnprocessed ? " **[UNPROCESSED]**" : "";
    // One line: sender, type, optional badge, payload
    const conversationEntry = `**${senderDisplayName}** ${envelope.type}:${unprocessedBadge} ${formattedPayload}`.replace(/\n+/g, " ").trim();

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
      const agentPrompt = `[AGORA MESSAGE from ${senderDisplayName}]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nPayload: ${payloadStr}\n\nRespond to this message if appropriate. Use the TinyBus MCP tool ${"`"}mcp__tinybus__send_message${"`"} with type "agora.send" to reply. Example: { type: "agora.send", payload: { peerName: "${senderDisplayName}", type: "publish", payload: { text: "your response" }, inReplyTo: "${envelope.id}" } }`;
      this.messageInjector.injectMessage(agentPrompt);
      this.logger.debug(`[AGORA] Injected message into orchestrator: envelopeId=${envelope.id}`);
    } catch (err) {
      this.logger.debug(`[AGORA] Failed to inject message into orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
