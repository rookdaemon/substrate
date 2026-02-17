import { IConversationManager } from "../conversation/IConversationManager";
import { IMessageInjector } from "../loop/IMessageInjector";
import { ILoopEventSink } from "../loop/ILoopEventSink";
import { IClock } from "../substrate/abstractions/IClock";
import { IAgoraService } from "./IAgoraService";
import { LoopState } from "../loop/types";
import { AgentRole } from "../agents/types";
import { shortKey } from "./utils";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

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
    private readonly isRateLimited: () => boolean = () => false
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

    // Determine if we should add [UNPROCESSED] marker
    // Check if effectively paused (explicitly paused OR rate-limited)
    const state = this.getState();
    const isUnprocessed = state === LoopState.STOPPED || state === LoopState.PAUSED || this.isRateLimited();
    const unprocessedMarker = isUnprocessed ? "[UNPROCESSED] " : "";

    // Format: [AGORA] [timestamp] [UNPROCESSED?] Type: {type} From: {senderShort} Envelope: {envelopeId} Payload: {payload}
    const conversationEntry = `[AGORA] [${timestamp}] ${unprocessedMarker}Type: ${envelope.type} From: ${senderShort} Envelope: ${envelope.id} Payload: ${payloadStr}`;

    // Write to CONVERSATION.md (using SUBCONSCIOUS role as it handles message processing)
    await this.conversationManager.append(AgentRole.SUBCONSCIOUS, conversationEntry);

    // Emit WebSocket event for frontend visibility
    if (this.eventSink) {
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
    }

    // Inject message directly into orchestrator (bypass TinyBus)
    // Format message as agent prompt similar to old checkAgoraInbox format
    const agentPrompt = `[AGORA MESSAGE from ${senderShort}]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nPayload: ${payloadStr}\n\nRespond to this message if appropriate. Use AgoraService.send() to reply.`;
    this.messageInjector.injectMessage(agentPrompt);
  }
}
