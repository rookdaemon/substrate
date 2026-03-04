import { IConversationManager } from "../conversation/IConversationManager";
import { IMessageInjector } from "../loop/IMessageInjector";
import { ILoopEventSink } from "../loop/ILoopEventSink";
import { IClock } from "../substrate/abstractions/IClock";
import { IAgoraService } from "./IAgoraService";
import { LoopState } from "../loop/types";
import { AgentRole } from "../agents/types";
import { shortKey } from "./utils";
import { IgnoredPeersManager } from "@rookdaemon/agora";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import type { ILogger } from "../logging";
import { createHash } from "crypto";

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
 * Policy for handling messages from senders not in PEERS registry
 * - 'allow': process normally (trust all callers)
 * - 'quarantine': append to CONVERSATION.md with [UNPROCESSED] but skip injection
 * - 'reject': log and discard without any processing
 */
export type UnknownSenderPolicy = 'allow' | 'quarantine' | 'reject';

/**
 * AgoraMessageHandler - Handles inbound Agora messages
 * 
 * Responsibilities:
 * - Write messages to CONVERSATION.md
 * - Add [UNPROCESSED] markers when process is stopped/paused
 * - Inject messages directly into orchestrator (bypasses TinyBus)
 * - Emit WebSocket events for frontend visibility
 * - Deduplicate envelopes to prevent replay attacks
 * - Enforce peer allowlist (unknown senders are silently dropped)
 * - Per-sender rate limiting to prevent flooding
 */
export class AgoraMessageHandler {
  /**
   * In-memory set of processed envelope IDs for deduplication.
   * NOTE: This set is lost on process restart, so the same envelope could be processed
   * twice across a restart. For idempotent substrate writes this is acceptable.
   * If stronger guarantees are needed, persist the last N IDs to a file on shutdown.
   */
  private processedEnvelopeIds: Set<string> = new Set();
  private readonly MAX_DEDUP_SIZE = 1000;
  private readonly senderWindows: Map<string, SenderWindow> = new Map();
  private static readonly MAX_SENDER_ENTRIES = 500;

  /**
   * Content-based dedup: Map of SHA-256(sender + type + payload) → first-seen timestamp.
   * Prevents identical content from the same sender being processed multiple times
   * within a time window, even when envelope IDs differ (#238).
   */
  private readonly contentDedup: Map<string, number> = new Map();
  private readonly CONTENT_DEDUP_WINDOW_MS = 1800000; // 30 minutes
  private readonly MAX_CONTENT_DEDUP_SIZE = 5000;
  private readonly ignoredPeersManager: IgnoredPeersManager | null;
  private readonly ignoredPeers: Set<string>;

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
    private readonly rateLimitConfig: RateLimitConfig = { enabled: true, maxMessages: 10, windowMs: 60000 },
    private readonly wakeLoop: (() => void) | null = null,
    private readonly ignoredPeersPath: string | null = null,
  ) {
    if (this.ignoredPeersPath) {
      try {
        this.ignoredPeersManager = new IgnoredPeersManager(this.ignoredPeersPath);
        this.ignoredPeers = new Set(this.ignoredPeersManager.listIgnoredPeers());
      } catch (error) {
        this.logger.debug(`[AGORA] Failed to initialize ignored peers manager: ${error instanceof Error ? error.message : String(error)}`);
        this.ignoredPeersManager = null;
        this.ignoredPeers = new Set();
      }
    } else {
      this.ignoredPeersManager = null;
      this.ignoredPeers = new Set();
    }
  }

  /**
   * Return all currently tracked processed envelope IDs (for persistence on shutdown).
   */
  getProcessedEnvelopeIds(): string[] {
    return Array.from(this.processedEnvelopeIds);
  }

  ignorePeer(publicKey: string): boolean {
    const normalized = publicKey.trim();
    if (!normalized) {
      return false;
    }
    const added = !this.ignoredPeers.has(normalized);
    this.ignoredPeers.add(normalized);
    if (added && this.ignoredPeersManager) {
      this.ignoredPeersManager.ignorePeer(normalized);
    }
    return added;
  }

  unignorePeer(publicKey: string): boolean {
    const normalized = publicKey.trim();
    const removed = this.ignoredPeers.delete(normalized);
    if (removed && this.ignoredPeersManager) {
      this.ignoredPeersManager.unignorePeer(normalized);
    }
    return removed;
  }

  listIgnoredPeers(): string[] {
    return Array.from(this.ignoredPeers.values()).sort();
  }

  /**
   * Restore processed envelope IDs from persistent storage (called on startup).
   * Silently discards entries exceeding MAX_DEDUP_SIZE (keeps the most-recent tail).
   */
  setProcessedEnvelopeIds(ids: string[]): void {
    this.processedEnvelopeIds = new Set(ids.slice(-this.MAX_DEDUP_SIZE));
  }

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
   * Content-based dedup: check if this sender + type + payload combination
   * has been seen within the dedup window (#238).
   * Returns true if duplicate content, false if new.
   */
  private isDuplicateContent(senderPublicKey: string, messageType: string, payload: unknown): boolean {
    const hash = createHash("sha256")
      .update(senderPublicKey)
      .update(messageType)
      .update(JSON.stringify(payload))
      .digest("hex");

    const now = this.clock.now().getTime();
    const firstSeen = this.contentDedup.get(hash);

    if (firstSeen !== undefined && (now - firstSeen) < this.CONTENT_DEDUP_WINDOW_MS) {
      this.logger.debug(
        `[AGORA] Duplicate content from ${shortKey(senderPublicKey)} type=${messageType} (hash=${hash.slice(0, 12)}…) — skipping (#238)`
      );
      return true;
    }

    // New content or expired window — record it
    this.contentDedup.set(hash, now);

    // Bound map size: evict entries older than the window
    if (this.contentDedup.size > this.MAX_CONTENT_DEDUP_SIZE) {
      for (const [key, ts] of this.contentDedup.entries()) {
        if ((now - ts) >= this.CONTENT_DEDUP_WINDOW_MS) {
          this.contentDedup.delete(key);
        }
      }
      // If still over limit after expiry sweep, remove oldest
      if (this.contentDedup.size > this.MAX_CONTENT_DEDUP_SIZE) {
        const oldestKey = this.contentDedup.keys().next().value;
        if (oldestKey !== undefined) {
          this.contentDedup.delete(oldestKey);
        }
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
   * Resolve sender name metadata (not identity): prefer relay hint, then local peer registry.
   */
  private resolveSenderName(senderPublicKey: string, relayNameHint?: string): string | undefined {
    const keySuffix = shortKey(senderPublicKey);
    const normalizedHint = relayNameHint?.trim();

    // Prefer relay name hint if provided and not itself a short-key label.
    if (normalizedHint && normalizedHint !== keySuffix && !/^\.\.\.[a-f0-9]{8}$/i.test(normalizedHint)) {
      return normalizedHint;
    }

    return this.findPeerByPublicKey(senderPublicKey);
  }

  /**
   * Sender identity format for durable logs/conversation:
   * - known peers (present in peer registry): shortKey(name) or shortKey
   * - unknown peers: fullKey(name) or fullKey
   */
  private formatSenderIdentity(senderPublicKey: string, relayNameHint?: string): string {
    const senderName = this.resolveSenderName(senderPublicKey, relayNameHint);
    const isKnownPeer = this.findPeerByPublicKey(senderPublicKey) !== undefined;
    const displayKey = isKnownPeer ? shortKey(senderPublicKey) : senderPublicKey;
    return senderName ? `${displayKey}(${senderName})` : displayKey;
  }

  /**
   * Format a payload string for display in CONVERSATION.md.
   * Returns a user-friendly representation of the payload.
   */
  private formatPayload(payloadStr: string): string {
    try {
      const parsed = JSON.parse(payloadStr);
      if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
        const keys = Object.keys(parsed);
        if (keys.length === 1 && keys[0] === "text" && typeof parsed.text === "string") {
          return parsed.text;
        } else if (keys.length <= 5 && keys.every(k => typeof parsed[k] === "string" || typeof parsed[k] === "number" || typeof parsed[k] === "boolean")) {
          return Object.entries(parsed)
            .map(([k, v]) => `**${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
            .join(", ");
        } else {
          return JSON.stringify(parsed, null, 2);
        }
      }
    } catch {
      // fall through
    }
    return payloadStr;
  }

  async processEnvelope(envelope: Envelope, source: "webhook" | "relay" = "webhook", relayNameHint?: string): Promise<void> {
    if (this.ignoredPeers.has(envelope.sender)) {
      this.logger.debug(`[AGORA] Ignoring message from blocked sender ${shortKey(envelope.sender)}: envelopeId=${envelope.id}`);
      return;
    }

    // Check for duplicate envelope ID early - return without processing if duplicate
    if (this.isDuplicate(envelope.id)) {
      return;
    }

    // Content-based dedup (#238): catch identical messages with different envelope IDs
    // (e.g., announce heartbeat loops sending same payload every ~2 minutes)
    if (this.isDuplicateContent(envelope.sender, envelope.type, envelope.payload)) {
      return;
    }

    const timestamp = this.clock.now().toISOString();
    const senderIdentity = this.formatSenderIdentity(envelope.sender, relayNameHint);
    const payloadStr = JSON.stringify(envelope.payload);

    this.logger.debug(`[AGORA] Received ${source} message: envelopeId=${envelope.id} type=${envelope.type} from=${senderIdentity}`);
    this.logger.verbose(`[AGORA] Envelope payload: envelopeId=${envelope.id} payload=${payloadStr}`);

    // Security check: enforce peer allowlist
    const senderPublicKey = envelope.sender;
    const knownPeer = this.findPeerByPublicKey(senderPublicKey);

    if (!knownPeer) {
      if (this.unknownSenderPolicy === 'reject') {
        this.logger.debug(`[AGORA] Rejected message from unknown sender ${shortKey(senderPublicKey)} (policy: reject)`);
        return;
      } else if (this.unknownSenderPolicy === 'quarantine') {
        this.logger.debug(`[AGORA] Quarantining message from unknown sender ${shortKey(senderPublicKey)} (policy: quarantine)`);
        const formattedPayload = this.formatPayload(payloadStr);
        const conversationEntry = `**${senderIdentity}** ${envelope.type}: **[UNPROCESSED]** ${formattedPayload}`.replace(/\n+/g, " ").trim();
        try {
          await this.conversationManager.append(AgentRole.SUBCONSCIOUS, conversationEntry);
          this.logger.debug(`[AGORA] Quarantined message written to CONVERSATION.md: envelopeId=${envelope.id}`);
        } catch (err) {
          this.logger.debug(`[AGORA] Failed to write quarantined message to CONVERSATION.md: ${err instanceof Error ? err.message : String(err)}`);
          throw err;
        }
        return;
      }
      // policy === 'allow': continue processing
      this.logger.debug(`[AGORA] Allowing message from unknown sender ${shortKey(senderPublicKey)} (policy: allow)`);
    }

    // Check per-sender rate limit
    if (this.isRateLimitedSender(envelope.sender)) {
      this.logger.debug(`[AGORA] Dropping rate-limited message: envelopeId=${envelope.id} from=${senderIdentity}`);
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
    const replyInstruction = knownPeer
      ? `Respond to this message if appropriate. Use ${"`"}mcp__tinybus__send_agora_message${"`"} (Claude Code) or ${"`"}send_agora_message${"`"} (Gemini CLI) with: peerName="${knownPeer}", text="your response", inReplyTo="${envelope.id}"`
      : `Respond to this message if appropriate. Note: Sender (${senderIdentity}) is not in PEERS.md, but you can reply via relay. Use ${"`"}mcp__tinybus__send_agora_message${"`"} (Claude Code) or ${"`"}send_agora_message${"`"} (Gemini CLI) with: targetPubkey="${envelope.sender}", text="your response", inReplyTo="${envelope.id}"`;
    try {
      const agentPrompt = `[AGORA MESSAGE from ${senderIdentity}]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nPayload: ${payloadStr}\n\n${replyInstruction}`;
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

    const formattedPayload = this.formatPayload(payloadStr);
    const unprocessedBadge = isUnprocessed ? " **[UNPROCESSED]**" : "";
    // One line: sender, type, optional badge, payload
    const conversationEntry = `**${senderIdentity}** ${envelope.type}:${unprocessedBadge} ${formattedPayload}`.replace(/\n+/g, " ").trim();

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

}
