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
import type { AgoraInboxManager } from "./AgoraInboxManager";

export type UnknownSenderPolicy = 'allow' | 'quarantine' | 'reject';

/**
 * Sliding window state for per-sender rate limiting
 */
interface SenderWindow {
  count: number;
  windowStart: number;
}

/**
 * Configuration for per-sender rate limiting
 */
export interface RateLimitConfig {
  enabled: boolean;
  maxMessages: number;
  windowMs: number;
}

/**
 * AgoraMessageHandler - Handles inbound Agora messages
 * 
 * Responsibilities:
 * - Write messages to CONVERSATION.md
 * - Add [UNPROCESSED] markers when process is stopped/paused
 * - Inject messages directly into orchestrator (bypasses TinyBus)
 * - Emit WebSocket events for frontend visibility
 * - Deduplicate envelopes to prevent replay attacks
 * - Enforce peer allowlist via unknownSenderPolicy
 * - Per-sender rate limiting to prevent flooding
 */
export class AgoraMessageHandler {
  private processedEnvelopeIds: Set<string> = new Set();
  private readonly MAX_DEDUP_SIZE = 1000;
  private readonly senderWindows: Map<string, SenderWindow> = new Map();
  private static readonly MAX_SENDER_ENTRIES = 500;

  constructor(
    private readonly agoraService: IAgoraService | null,
    private readonly conversationManager: IConversationManager,
    private readonly messageInjector: IMessageInjector,
    private readonly eventSink: ILoopEventSink | null,
    private readonly clock: IClock,
    private readonly getState: () => LoopState,
    private readonly isRateLimited: () => boolean = () => false,
    private readonly logger: ILogger,
    private readonly unknownSenderPolicy: UnknownSenderPolicy = 'quarantine',
    private readonly inboxManager: AgoraInboxManager | null = null,
    private readonly rateLimitConfig: RateLimitConfig = { enabled: true, maxMessages: 10, windowMs: 60000 },
    private readonly wakeLoop: (() => void) | null = null
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
   * Find peer in registry by public key
   * Returns peer name if found, undefined otherwise
   */
  private findPeerByPublicKey(publicKey: string): string | undefined {
    if (!this.agoraService) {
      return undefined;
    }

    const peers = this.agoraService.getPeers();
    for (const peerName of peers) {
      const peerConfig = this.agoraService.getPeerConfig(peerName);
      if (peerConfig && peerConfig.publicKey === publicKey) {
        return peerName;
      }
    }

    return undefined;
  }

  /**
   * Check if sender should be rate-limited based on sliding window
   * Also handles Map eviction to prevent unbounded memory growth
   */
  private isRateLimitedSender(senderPublicKey: string): boolean {
    if (!this.rateLimitConfig.enabled) {
      return false;
    }

    const now = this.clock.now().getTime();
    const window = this.senderWindows.get(senderPublicKey);

    // Check if we need to evict oldest entries to keep Map bounded
    if (this.senderWindows.size >= AgoraMessageHandler.MAX_SENDER_ENTRIES && !window) {
      this.evictOldestSenderWindow();
    }

    if (!window || (now - window.windowStart) > this.rateLimitConfig.windowMs) {
      // New window - reset count
      this.senderWindows.set(senderPublicKey, { count: 1, windowStart: now });
      return false;
    }

    // Within existing window - increment count
    window.count++;

    if (window.count > this.rateLimitConfig.maxMessages) {
      this.logger.debug(
        `[AGORA] Rate limiting sender ${shortKey(senderPublicKey)}: ${window.count} messages in ${this.rateLimitConfig.windowMs}ms window (max: ${this.rateLimitConfig.maxMessages})`
      );
      return true;
    }

    return false;
  }

  /**
   * Evict the oldest sender window entry to prevent unbounded Map growth
   */
  private evictOldestSenderWindow(): void {
    let oldestKey: string | null = null;
    let oldestTime = Infinity;

    for (const [key, window] of this.senderWindows.entries()) {
      if (window.windowStart < oldestTime) {
        oldestTime = window.windowStart;
        oldestKey = key;
      }
    }

    if (oldestKey !== null) {
      this.senderWindows.delete(oldestKey);
      this.logger.debug(`[AGORA] Evicted oldest sender window: ${shortKey(oldestKey)}`);
    }
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

    // Try to find peer name by matching public key in local registry
    const peerName = this.findPeerByPublicKey(senderPublicKey);
    if (peerName) {
      // Found matching peer - return name...shortKey format
      return `${peerName}...${shortKey(senderPublicKey).slice(3)}`; // Remove "..." prefix from shortKey
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

    // Security check: enforce peer allowlist
    const senderPublicKey = envelope.sender;
    const knownPeer = this.findPeerByPublicKey(senderPublicKey);

    if (!knownPeer) {
      if (this.unknownSenderPolicy === 'quarantine') {
        // Log to quarantine section but do NOT inject into agent loop
        this.logger.debug(`[AGORA] Message from unknown sender ${shortKey(senderPublicKey)} — quarantined`);
        await this.writeQuarantinedMessage(envelope, source);
        return;
      } else if (this.unknownSenderPolicy === 'reject') {
        this.logger.debug(`[AGORA] Rejected message from unknown sender ${shortKey(senderPublicKey)}`);
        return;
      }
      // 'allow' = existing behavior, fall through
    }

    // Check per-sender rate limit
    if (this.isRateLimitedSender(envelope.sender)) {
      this.logger.debug(`[AGORA] Dropping rate-limited message: envelopeId=${envelope.id} from=${senderDisplayName}`);
      // Silently drop the message - don't reveal rate limit state to potential spammers
      return;
    }

    // Wake loop if sleeping — incoming Agora message should restart cycles
    if (this.getState() === LoopState.SLEEPING && this.wakeLoop) {
      this.logger.debug(`[AGORA] Waking loop from SLEEPING state for incoming message: envelopeId=${envelope.id}`);
      this.wakeLoop();
    }

    // Inject message into orchestrator FIRST so we know if it was delivered to an active session.
    // This determines whether to mark the CONVERSATION.md entry as [UNPROCESSED].
    // Format message as agent prompt similar to old checkAgoraInbox format
    let injected = false;
    try {
      const agentPrompt = `[AGORA MESSAGE from ${senderDisplayName}]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nPayload: ${payloadStr}\n\nRespond to this message if appropriate. Use the TinyBus MCP tool ${"`"}mcp__tinybus__send_message${"`"} with type "agora.send" to reply. Example: { type: "agora.send", payload: { peerName: "${senderDisplayName}", type: "publish", payload: { text: "your response" }, inReplyTo: "${envelope.id}" } }`;
      injected = this.messageInjector.injectMessage(agentPrompt);
      this.logger.debug(`[AGORA] Injected message into orchestrator: envelopeId=${envelope.id} delivered=${injected}`);
    } catch (err) {
      this.logger.debug(`[AGORA] Failed to inject message into orchestrator: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }

    // Determine if we should add [UNPROCESSED] marker.
    // Mark as unprocessed when:
    // - message was NOT delivered to an active session (between cycles or between ticks), OR
    // - loop is explicitly stopped/paused, OR
    // - global rate limit is active
    // The [UNPROCESSED] badge persists in CONVERSATION.md across restarts so the agent
    // can pick it up on the next cycle without losing the message.
    const state = this.getState();
    const isUnprocessed = !injected || state === LoopState.STOPPED || state === LoopState.PAUSED || this.isRateLimited();

    if (isUnprocessed) {
      this.logger.debug(`[AGORA] Message marked as UNPROCESSED (delivered=${injected}, state=${state}, rateLimited=${this.isRateLimited()})`);
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
  }

  /**
   * Write a quarantined message to AGORA_INBOX.md
   * These messages are not injected into the agent loop
   */
  private async writeQuarantinedMessage(envelope: Envelope, source: "webhook" | "relay" = "webhook"): Promise<void> {
    if (!this.inboxManager) {
      this.logger.debug(`[AGORA] No inbox manager configured, cannot quarantine message`);
      return;
    }

    try {
      await this.inboxManager.addQuarantinedMessage(envelope, source);
      this.logger.debug(`[AGORA] Quarantined message written: envelopeId=${envelope.id}`);
    } catch (err) {
      this.logger.debug(`[AGORA] Failed to write quarantined message: ${err instanceof Error ? err.message : String(err)}`);
      throw err;
    }
  }
}
