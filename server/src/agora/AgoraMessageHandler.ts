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
   * Process an inbound Agora envelope (called by webhook handler or relay)
   * 
   * Pipeline:
   * 1. Write to CONVERSATION.md with [UNPROCESSED] marker if stopped/paused
   * 2. Emit WebSocket event
   * 3. Inject message directly into orchestrator (no TinyBus)
   */
  async processEnvelope(envelope: Envelope, source: "webhook" | "relay" = "webhook"): Promise<void> {
    const timestamp = this.clock.now().toISOString();
    const senderShort = shortKey(envelope.sender);
    const payloadStr = JSON.stringify(envelope.payload);

    this.logger.debug(`[AGORA] Received ${source} message: envelopeId=${envelope.id} type=${envelope.type} from=${senderShort}`);

    // Determine if we should add [UNPROCESSED] marker
    // Check if effectively paused (explicitly paused OR rate-limited)
    const state = this.getState();
    const isUnprocessed = state === LoopState.STOPPED || state === LoopState.PAUSED || this.isRateLimited();
    const unprocessedMarker = isUnprocessed ? "[UNPROCESSED] " : "";

    if (isUnprocessed) {
      this.logger.debug(`[AGORA] Message marked as UNPROCESSED (state=${state}, rateLimited=${this.isRateLimited()})`);
    }

    // Format: [AGORA] [timestamp] [UNPROCESSED?] Type: {type} From: {senderShort} Envelope: {envelopeId} Payload: {payload}
    const conversationEntry = `[AGORA] [${timestamp}] ${unprocessedMarker}Type: ${envelope.type} From: ${senderShort} Envelope: ${envelope.id} Payload: ${payloadStr}`;

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
      const agentPrompt = `[AGORA MESSAGE from ${senderShort}]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nPayload: ${payloadStr}\n\nRespond to this message if appropriate. Use AgoraService.send() to reply.`;
      this.messageInjector.injectMessage(agentPrompt);
      this.logger.debug(`[AGORA] Injected message into orchestrator: envelopeId=${envelope.id}`);
    } catch (err) {
      this.logger.debug(`[AGORA] Failed to inject message into orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
