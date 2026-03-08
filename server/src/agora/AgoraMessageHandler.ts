import { IConversationManager } from "../conversation/IConversationManager";
import { IMessageInjector } from "../loop/IMessageInjector";
import { ILoopEventSink } from "../loop/ILoopEventSink";
import { IClock } from "../substrate/abstractions/IClock";
import { IAgoraService } from "./IAgoraService";
import { LoopState } from "../loop/types";
import { AgentRole } from "../agents/types";
import { buildPeerReferenceDirectory, compactKnownInlineReferences, compactPeerReference, shortKey } from "./utils";
import { IgnoredPeersManager, SeenKeyStore } from "@rookdaemon/agora";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import type { ILogger } from "../logging";
import { createHash } from "crypto";
import type { IFlashGate, FlashGateVerdict } from "../gates/IFlashGate";

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
/**
 * Message types that are subject to F2 gate evaluation.
 * Per spec: actionable message types only. Announce and infrastructure messages are excluded.
 * Note: Agora library has no "dm" type — publish with TO recipients serves as direct messaging,
 * and request is also actionable. Both are gated.
 */
const F2_GATED_TYPES = new Set(["publish", "request"]);

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
  private readonly seenKeyStore: SeenKeyStore | null;

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
    private readonly seenKeysPath: string | null = null,
    private readonly flashGate: IFlashGate | null = null,
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

    if (this.seenKeysPath) {
      try {
        this.seenKeyStore = new SeenKeyStore(this.seenKeysPath);
      } catch (error) {
        this.logger.debug(`[AGORA] Failed to initialize seen-key store: ${error instanceof Error ? error.message : String(error)}`);
        this.seenKeyStore = null;
      }
    } else {
      this.seenKeyStore = null;
    }
  }

  /**
   * Return all currently tracked processed envelope IDs (for persistence on shutdown).
   */
  getProcessedEnvelopeIds(): string[] {
    return Array.from(this.processedEnvelopeIds);
  }

  /**
   * Access the seen-key store (or null if not configured).
   */
  getSeenKeyStore(): SeenKeyStore | null {
    return this.seenKeyStore;
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
    // agora v0.4.5: peers map is keyed by public key, so getPeerConfig resolves
    // directly. Return the name field (the human-readable label), not the map key.
    return this.agoraService.getPeerConfig(publicKey)?.name;
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
   * Sender identity format for durable logs/conversation:
   * - known peers: name@<last8>
   * - unknown peers: @<last8>
   * Identity is always derived from verified public keys, never from claimed names.
   */
  private formatSenderIdentity(senderPublicKey: string): string {
    const directory = buildPeerReferenceDirectory(this.agoraService, this.seenKeyStore ?? undefined);
    return compactPeerReference(senderPublicKey, directory);
  }

  private formatRecipientIdentity(publicKey: string): string {
    const directory = buildPeerReferenceDirectory(this.agoraService, this.seenKeyStore ?? undefined);
    return compactPeerReference(publicKey, directory);
  }

  private compactPayloadValue(payload: unknown, directory: ReturnType<typeof buildPeerReferenceDirectory>): unknown {
    if (typeof payload === "string") {
      return compactKnownInlineReferences(payload, directory);
    }

    if (Array.isArray(payload)) {
      return payload.map((item) => this.compactPayloadValue(item, directory));
    }

    if (payload && typeof payload === "object") {
      const compacted: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(payload as Record<string, unknown>)) {
        compacted[key] = this.compactPayloadValue(value, directory);
      }
      return compacted;
    }

    return payload;
  }

  /**
   * Format a payload string for display in CONVERSATION.md.
   * Returns a user-friendly representation of the payload.
   */
  private formatPayload(payload: unknown): string {
    const directory = buildPeerReferenceDirectory(this.agoraService, this.seenKeyStore ?? undefined);
    const compactedPayload = this.compactPayloadValue(payload, directory);

    if (typeof compactedPayload === "object" && compactedPayload !== null && !Array.isArray(compactedPayload)) {
      const parsed = compactedPayload as Record<string, unknown>;
      const keys = Object.keys(parsed);
      if (keys.length === 1 && keys[0] === "text" && typeof parsed.text === "string") {
        return parsed.text;
      }

      if (keys.length <= 5 && keys.every((k) => {
        const value = parsed[k];
        return typeof value === "string" || typeof value === "number" || typeof value === "boolean";
      })) {
        return Object.entries(parsed)
          .map(([k, v]) => `**${k}**: ${typeof v === "string" ? v : JSON.stringify(v)}`)
          .join(", ");
      }

      return JSON.stringify(parsed, null, 2);
    }

    if (typeof compactedPayload === "string") {
      return compactedPayload;
    }

    return JSON.stringify(compactedPayload);
  }

  /**
   * Evaluate inbound message through the F2 (Healthy Paranoia) gate.
   * Returns the verdict, or null if the gate is not available.
   */
  private async evaluateF2Gate(
    envelope: Envelope,
    senderIdentity: string,
    senderVerified: boolean,
    timestamp: string,
  ): Promise<FlashGateVerdict | null> {
    if (!this.flashGate) return null;

    // Extract readable text from payload for the gate
    let messageText: string;
    if (typeof envelope.payload === "object" && envelope.payload !== null) {
      const p = envelope.payload as Record<string, unknown>;
      messageText = typeof p.text === "string" ? p.text : JSON.stringify(envelope.payload);
    } else {
      messageText = String(envelope.payload);
    }

    try {
      return await this.flashGate.evaluateInput({
        sender_moniker: senderIdentity,
        sender_verified: senderVerified,
        message_text: messageText,
        message_type: envelope.type,
        envelope_id: envelope.id,
        timestamp,
      });
    } catch (err) {
      // Gate infrastructure failure — default to BLOCK per spec
      this.logger.debug(
        `[AGORA] F2 gate error: envelopeId=${envelope.id} error=${err instanceof Error ? err.message : String(err)} — defaulting to BLOCK`,
      );
      return {
        verdict: "BLOCK",
        reasons: [{
          id: 0,
          reason: `F2 gate infrastructure error: ${err instanceof Error ? err.message : String(err)}`,
          is_blocker: true,
          explanation: "Gate threw an unexpected error — defaulting to safe verdict",
        }],
      };
    }
  }

  async processEnvelope(envelope: Envelope, source: "webhook" | "relay" = "webhook"): Promise<void> {
    const envelopeRouting = envelope as Envelope & { from?: string; to?: string[]; sender?: string };
    const envelopeFrom = envelopeRouting.from ?? envelopeRouting.sender ?? "";
    const envelopeTo = Array.isArray(envelopeRouting.to) ? envelopeRouting.to : [];

    if (this.ignoredPeers.has(envelopeFrom)) {
      this.logger.debug(`[AGORA] Ignoring message from blocked sender ${shortKey(envelopeFrom)}: envelopeId=${envelope.id}`);
      return;
    }

    // Check for duplicate envelope ID early - return without processing if duplicate
    if (this.isDuplicate(envelope.id)) {
      return;
    }

    // Content-based dedup (#238): catch identical messages with different envelope IDs
    // (e.g., announce heartbeat loops sending same payload every ~2 minutes)
    if (this.isDuplicateContent(envelopeFrom, envelope.type, envelope.payload)) {
      return;
    }

    // Persist all encountered public keys for identity resolution.
    if (this.seenKeyStore) {
      if (envelopeFrom) {
        this.seenKeyStore.record(envelopeFrom);
      }
      for (const recipient of envelopeTo) {
        if (recipient) {
          this.seenKeyStore.record(recipient);
        }
      }
      this.seenKeyStore.flush();
    }

    const timestamp = this.clock.now().toISOString();
    const senderIdentity = this.formatSenderIdentity(envelopeFrom);
    const toList = envelopeTo.length > 0
      ? envelopeTo.map((recipient: string) => this.formatRecipientIdentity(recipient)).join(", ")
      : "(none)";
    const payloadStr = JSON.stringify(envelope.payload);

    this.logger.debug(`[AGORA] Received ${source} message: envelopeId=${envelope.id} type=${envelope.type} from=${senderIdentity}`);
    this.logger.verbose(`[AGORA] Envelope payload: envelopeId=${envelope.id} payload=${payloadStr}`);

    // Security check: enforce peer allowlist
    const senderPublicKey = envelopeFrom;
    const knownPeer = this.findPeerByPublicKey(senderPublicKey);

    if (!knownPeer) {
      if (this.unknownSenderPolicy === 'reject') {
        this.logger.debug(`[AGORA] Rejected message from unknown sender ${shortKey(senderPublicKey)} (policy: reject)`);
        return;
      } else if (this.unknownSenderPolicy === 'quarantine') {
        this.logger.debug(`[AGORA] Quarantining message from unknown sender ${shortKey(senderPublicKey)} (policy: quarantine)`);
        const formattedPayload = this.formatPayload(envelope.payload);
        const conversationEntry = `**FROM:** ${senderIdentity} **TO:** ${toList} ${envelope.type}: **[UNPROCESSED]** ${formattedPayload}`.replace(/\n+/g, " ").trim();
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
    if (this.isRateLimitedSender(envelopeFrom)) {
      this.logger.debug(`[AGORA] Dropping rate-limited message: envelopeId=${envelope.id} from=${senderIdentity}`);
      // Silently drop the message - don't reveal rate limit state to potential spammers
      return;
    }

    // F2 gate — pre-input behavioral filter (Healthy Paranoia)
    // Only applies to dm/publish message types (not announce/heartbeat).
    // If F2 BLOCKs, message never reaches Ego. If ESCALATE, inject with flag.
    if (this.flashGate && F2_GATED_TYPES.has(envelope.type)) {
      const f2Verdict = await this.evaluateF2Gate(
        envelope,
        senderIdentity,
        !!knownPeer,
        timestamp,
      );

      if (f2Verdict?.verdict === "BLOCK") {
        // Log the block to CONVERSATION.md for audit trail
        const blockReason = f2Verdict.auto_block
          ? f2Verdict.auto_block_reason ?? "Auto-blocked"
          : f2Verdict.reasons.find(r => r.is_blocker)?.reason ?? "Blocked by F2 gate";
        const formattedPayload = this.formatPayload(envelope.payload);
        const conversationEntry = `**FROM:** ${senderIdentity} **TO:** ${toList} ${envelope.type}: **[F2-BLOCKED]** ${formattedPayload}`.replace(/\n+/g, " ").trim();
        await this.conversationManager.append(AgentRole.SUBCONSCIOUS, conversationEntry);
        this.logger.debug(
          `[AGORA] F2 BLOCK: envelopeId=${envelope.id} sender=${senderIdentity} reason=${blockReason}`,
        );

        // Per spec: if sender is verified (known peer), send brief acknowledgment
        if (knownPeer && this.agoraService) {
          try {
            await this.agoraService.sendMessage({
              peerName: knownPeer,
              type: "dm",
              payload: { text: `Request not processed. Reason: ${blockReason}` },
              inReplyTo: envelope.id,
            });
          } catch (ackErr) {
            this.logger.debug(
              `[AGORA] Failed to send F2 BLOCK acknowledgment: ${ackErr instanceof Error ? ackErr.message : String(ackErr)}`,
            );
          }
        }
        return;
      }

      // ESCALATE: message continues to Ego but with escalation flag
      if (f2Verdict?.verdict === "ESCALATE") {
        this.logger.debug(
          `[AGORA] F2 ESCALATE: envelopeId=${envelope.id} sender=${senderIdentity} — passing to Ego with escalation flag`,
        );
      }

      // PROCEED or ESCALATE: continue processing (ESCALATE flag handled below in injection)
      // Store verdict for use in the injected message
      (envelope as Envelope & { _f2Verdict?: FlashGateVerdict })._f2Verdict = f2Verdict ?? undefined;
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
      ? `Respond to this message if appropriate. Use ${"\`"}mcp__tinybus__send_agora_message${"\`"} (Claude Code) or ${"\`"}send_agora_message${"\`"} (Gemini CLI) with: to="${senderIdentity}", text="your response", inReplyTo="${envelope.id}"`
      : `Respond to this message if appropriate. Note: Sender (${senderIdentity}) is not in PEERS.md, but you can reply via relay. Use ${"`"}mcp__tinybus__send_agora_message${"`"} (Claude Code) or ${"`"}send_agora_message${"`"} (Gemini CLI) with: to="${senderIdentity}", text="your response", inReplyTo="${envelope.id}"`;
    try {
      const f2Verdict = (envelope as Envelope & { _f2Verdict?: FlashGateVerdict })._f2Verdict;
      const f2EscalationBlock = f2Verdict?.verdict === "ESCALATE"
        ? `\n\n**[F2-ESCALATE]** The F2 security gate flagged uncertainty about this message. Surface to Stefan before acting. Top concerns:\n${f2Verdict.reasons.filter(r => r.is_blocker).map(r => `- ${r.reason}: ${r.explanation}`).join("\n") || "- Gate returned ESCALATE without specific blockers"}`
        : "";
      const agentPrompt = `[AGORA MESSAGE]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nFROM: ${senderIdentity}\nTO: ${toList}\nPayload: ${payloadStr}\n\n${replyInstruction}${f2EscalationBlock}`;
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

    const formattedPayload = this.formatPayload(envelope.payload);
    const unprocessedBadge = isUnprocessed ? " **[UNPROCESSED]**" : "";
    const conversationEntry = `**FROM:** ${senderIdentity} **TO:** ${toList} ${envelope.type}:${unprocessedBadge} ${formattedPayload}`.replace(/\n+/g, " ").trim();

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
            from: envelopeFrom,
            to: envelopeTo,
            sender: envelopeFrom,
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
