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
import type { IFlashGate, EnvelopeSummary } from "../gates/IFlashGate";

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
 * Status returned by processEnvelope() to describe how the message was handled.
 * - 'injected': delivered directly into an active agent session
 * - 'queued': accepted and written to CONVERSATION.md; will be processed in next cycle
 * - 'unprocessed': accepted but loop is stopped/paused/rate-limited; marked [UNPROCESSED]
 * - 'ignored': dropped (duplicate, blocked sender, rate-limited, or filtered by gate)
 */
export type MessageStatus = 'injected' | 'queued' | 'unprocessed' | 'ignored';

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
 * - F2 gate evaluation (Healthy Paranoia) before message injection
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
  private readonly seenKeyStore: SeenKeyStore | null;

  /**
   * In-memory cache of recently processed envelope summaries for inReplyTo context lookup.
   * When an inbound message has inReplyTo set, we look up the parent envelope here
   * so the F2 gate can include authorization chain context in its evaluation.
   * Bounded to MAX_ENVELOPE_CACHE_SIZE entries; oldest entries evicted when full.
   */
  private readonly envelopeCache: Map<string, EnvelopeSummary> = new Map();
  private static readonly MAX_ENVELOPE_CACHE_SIZE = 200;

  /** Optional callback invoked after each successfully processed inbound message. */
  private onMessageProcessed: (() => void) | null = null;

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
   * Register a callback that is invoked after each successfully processed inbound message.
   * Used by HeartbeatScheduler to detect the `when: agora_peer_message` condition.
   */
  setOnMessageProcessed(callback: () => void): void {
    this.onMessageProcessed = callback;
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
   * Return all currently tracked per-sender rate-limit windows (for persistence on shutdown).
   * Serialized as a plain object keyed by sender public key.
   */
  getSenderWindows(): Record<string, SenderWindow> {
    const result: Record<string, SenderWindow> = {};
    for (const [key, window] of this.senderWindows.entries()) {
      result[key] = { ...window };
    }
    return result;
  }

  /**
   * Restore per-sender rate-limit windows from persistent storage (called on startup).
   * Silently discards entries whose window has already expired so that senders whose
   * throttle window elapsed before the restart are not unfairly kept throttled.
   * Caps restored entries at MAX_SENDER_ENTRIES to prevent unbounded memory growth.
   */
  setSenderWindows(state: Record<string, SenderWindow>): void {
    const now = this.clock.now().getTime();
    this.senderWindows.clear();
    for (const [key, window] of Object.entries(state)) {
      if (this.senderWindows.size >= AgoraMessageHandler.MAX_SENDER_ENTRIES) {
        break;
      }
      // Only restore windows still within the active rate-limit window
      if ((now - window.windowStart) <= this.rateLimitConfig.windowMs) {
        this.senderWindows.set(key, { count: window.count, windowStart: window.windowStart });
      }
    }
  }

  /**
   * Structural (infrastructure) message types that are expected to repeat with identical
   * content (e.g., periodic announce heartbeats). Only these types are subject to
   * content-based dedup. Conversational types (dm, publish, request, …) must never be
   * content-deduped because a peer legitimately sending the same text twice deserves two
   * distinct entries in CONVERSATION.md.
   */
  private static readonly STRUCTURAL_MESSAGE_TYPES = new Set(["announce", "heartbeat"]);

  /**
   * Check if an envelope ID has already been processed.
   * Returns true if duplicate, false if new.
   * Registers the ID immediately upon first encounter to block concurrent duplicate
   * deliveries (e.g. webhook + relay overlap, or relay reconnect mid-flight delivery).
   * If the write to CONVERSATION.md later fails, call removeFromDedup() to restore
   * retry eligibility for future relay reconnect replays.
   */
  private isDuplicate(envelopeId: string): boolean {
    if (this.processedEnvelopeIds.has(envelopeId)) {
      this.logger.debug(`[AGORA] Duplicate envelope ${envelopeId} — skipping`);
      return true;
    }

    // Register immediately to block concurrent duplicates.
    // Size-bounded with oldest-first eviction.
    this.processedEnvelopeIds.add(envelopeId);
    if (this.processedEnvelopeIds.size > this.MAX_DEDUP_SIZE) {
      const oldest = this.processedEnvelopeIds.values().next().value;
      if (oldest !== undefined) {
        this.processedEnvelopeIds.delete(oldest);
      }
    }

    return false;
  }

  /**
   * Remove an envelope ID from the processed set.
   * Called when a write to CONVERSATION.md fails so that future relay retries
   * (e.g. reconnect-driven replay) are not permanently blocked by a transient error.
   */
  private removeFromDedup(envelopeId: string): void {
    this.processedEnvelopeIds.delete(envelopeId);
  }

  /**
   * Content-based dedup: check if this sender + type + payload combination
   * has been seen within the dedup window (#238).
   * Only applies to structural message types (announce, heartbeat) — never to conversational
   * types such as dm or publish, where the same content sent twice is a legitimate repeat.
   * Returns true if duplicate content, false if new (does NOT record — call recordProcessed after write).
   */
  private isDuplicateContent(senderPublicKey: string, messageType: string, payload: unknown): boolean {
    if (!AgoraMessageHandler.STRUCTURAL_MESSAGE_TYPES.has(messageType)) {
      return false;
    }

    const hash = this.computeContentHash(senderPublicKey, messageType, payload);
    const now = this.clock.now().getTime();
    const firstSeen = this.contentDedup.get(hash);

    if (firstSeen !== undefined && (now - firstSeen) < this.CONTENT_DEDUP_WINDOW_MS) {
      this.logger.debug(
        `[AGORA] Duplicate content from ${shortKey(senderPublicKey)} type=${messageType} (hash=${hash.slice(0, 12)}…) — skipping (#238)`
      );
      return true;
    }

    return false;
  }

  /** Compute a stable SHA-256 hash over sender + type + payload for content-based dedup. */
  private computeContentHash(senderPublicKey: string, messageType: string, payload: unknown): string {
    return createHash("sha256")
      .update(senderPublicKey)
      .update(messageType)
      .update(JSON.stringify(payload))
      .digest("hex");
  }

  /**
   * Record content-based dedup for structural message types after a successful write.
   * The envelope-ID deduplication is handled by isDuplicate() at check time so that
   * concurrent deliveries are blocked immediately. This method only needs to maintain
   * the contentDedup map for structural types (announce, heartbeat) to suppress
   * periodic repeats within the 30-minute dedup window.
   */
  private recordProcessed(envelopeId: string, senderPublicKey: string, messageType: string, payload: unknown): void {
    // Record content hash only for structural message types.
    // (The envelope ID is already registered in processedEnvelopeIds by isDuplicate().)
    if (AgoraMessageHandler.STRUCTURAL_MESSAGE_TYPES.has(messageType)) {
      const hash = this.computeContentHash(senderPublicKey, messageType, payload);
      const now = this.clock.now().getTime();
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
    }
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

  async processEnvelope(envelope: Envelope, source: "webhook" | "relay" = "webhook"): Promise<MessageStatus> {
    const envelopeRouting = envelope as Envelope & { from?: string; to?: string[]; sender?: string };
    const envelopeFrom = envelopeRouting.from ?? envelopeRouting.sender ?? "";
    const envelopeTo = Array.isArray(envelopeRouting.to) ? envelopeRouting.to : [];

    if (this.ignoredPeers.has(envelopeFrom)) {
      this.logger.debug(`[AGORA] Ignoring message from blocked sender ${shortKey(envelopeFrom)}: envelopeId=${envelope.id}`);
      return 'ignored';
    }

    // Skip messages sent by this agent (relay echo)
    const selfIdentity = this.agoraService?.getSelfIdentity();
    if (selfIdentity?.publicKey && envelopeFrom === selfIdentity.publicKey) {
      this.logger.debug(`[AGORA] Skipping self-echo: envelopeId=${envelope.id}`);
      return 'ignored';
    }

    // Check for duplicate envelope ID early - return without processing if duplicate
    if (this.isDuplicate(envelope.id)) {
      return 'ignored';
    }

    // Content-based dedup (#238): catch identical messages with different envelope IDs
    // (e.g., announce heartbeat loops sending same payload every ~2 minutes)
    if (this.isDuplicateContent(envelopeFrom, envelope.type, envelope.payload)) {
      return 'ignored';
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
        return 'ignored';
      } else if (this.unknownSenderPolicy === 'quarantine') {
        this.logger.debug(`[AGORA] Quarantining message from unknown sender ${shortKey(senderPublicKey)} (policy: quarantine)`);
        const formattedPayload = this.formatPayload(envelope.payload);
        const conversationEntry = `**FROM:** ${senderIdentity} **TO:** ${toList} ${envelope.type}: **[UNPROCESSED]** ${formattedPayload}`.replace(/\n+/g, " ").trim();
        try {
          await this.conversationManager.append(AgentRole.SUBCONSCIOUS, conversationEntry);
          this.logger.debug(`[AGORA] Quarantined message written to CONVERSATION.md: envelopeId=${envelope.id}`);
          this.recordProcessed(envelope.id, envelopeFrom, envelope.type, envelope.payload);
        } catch (err) {
          this.logger.debug(`[AGORA] Failed to write quarantined message to CONVERSATION.md: ${err instanceof Error ? err.message : String(err)}`);
          // Unregister the ID so relay retries (e.g. reconnect-driven replay) can redeliver.
          this.removeFromDedup(envelope.id);
          throw err;
        }
        return 'unprocessed';
      }
      // policy === 'allow': continue processing
      this.logger.debug(`[AGORA] Allowing message from unknown sender ${shortKey(senderPublicKey)} (policy: allow)`);
    }

    // Check per-sender rate limit
    if (this.isRateLimitedSender(envelopeFrom)) {
      this.logger.debug(`[AGORA] Dropping rate-limited message: envelopeId=${envelope.id} from=${senderIdentity}`);
      // Silently drop the message - don't reveal rate limit state to potential spammers
      return 'ignored';
    }

    // F2 FlashGate: lightweight pre-check (timestamp anomaly, etc.)
    if (this.flashGate) {
      const preCheck = await this.flashGate.evaluate(envelope);
      if (preCheck.decision === "BLOCK") {
        this.logger.debug(`[AGORA] FlashGate BLOCK: envelopeId=${envelope.id} reason=${preCheck.reason ?? "(none)"}`);
        return 'ignored';
      }
      if (preCheck.decision === "ESCALATE") {
        this.logger.debug(`[AGORA] FlashGate ESCALATE: envelopeId=${envelope.id} reason=${preCheck.reason ?? "(none)"}`);
        // Continue processing but the reason is logged for operator review.
      }
    }

    // F2 Gate (Healthy Paranoia) — LLM-based evaluation for untrusted dm/publish messages.
    // Skips announce and heartbeat (infrastructure noise).
    // DMs from known, configured peers are trusted channels — skip F2 to avoid false positives.
    // Publish messages always go through F2 (broadcast relay could be compromised).
    // Only runs when a FlashGate is wired (optional dependency).
    const isF2Scope = ((envelope.type as string) === "dm" && !knownPeer) || envelope.type === "publish";
    if (this.flashGate && isF2Scope) {
      const envelopeWithReplyTo = envelope as Envelope & { inReplyTo?: string };
      const inReplyToSummary = envelopeWithReplyTo.inReplyTo
        ? this.envelopeCache.get(envelopeWithReplyTo.inReplyTo)
        : undefined;

      if (envelopeWithReplyTo.inReplyTo && !inReplyToSummary) {
        this.logger.debug(
          `[F2] inReplyTo envelope ${envelopeWithReplyTo.inReplyTo} not in cache — proceeding without context`,
        );
      }

      const peerContext = knownPeer ? `${senderIdentity} — known configured peer` : undefined;
      const messageText = this.extractMessageText(envelope.payload);
      const gateResult = await this.flashGate.evaluateF2({
        gate: "F2",
        context: {
          sender_moniker: senderIdentity,
          sender_verified: !!knownPeer,
          message_text: messageText,
          message_type: envelope.type,
          envelope_id: envelope.id,
          timestamp,
          inReplyToSummary,
          peer_context: peerContext,
        },
      });

      if (gateResult.verdict === "BLOCK") {
        this.logger.debug(
          `[F2] BLOCK — envelopeId=${envelope.id} sender=${senderIdentity} reasons=${JSON.stringify(gateResult.reasons)}`,
        );
        // Discard: do not inject and do not write to CONVERSATION.md
        return 'ignored';
      }

      if (gateResult.verdict === "ESCALATE") {
        this.logger.debug(
          `[F2] ESCALATE — envelopeId=${envelope.id} sender=${senderIdentity} reasons=${JSON.stringify(gateResult.reasons)}`,
        );
        // Fall through with escalation logged; injection continues normally
      }
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
      const agentPrompt = `[AGORA MESSAGE]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nTimestamp: ${timestamp}\nFROM: ${senderIdentity}\nTO: ${toList}\nPayload: ${payloadStr}\n\n${replyInstruction}`;
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
      // Record content dedup after successful write (envelope ID was already registered
      // by isDuplicate() at entry to this function).
      this.recordProcessed(envelope.id, envelopeFrom, envelope.type, envelope.payload);
    } catch (err) {
      this.logger.debug(`[AGORA] Failed to write to CONVERSATION.md: ${err instanceof Error ? err.message : String(err)}`);
      // Unregister the ID so relay retries (e.g. reconnect-driven replay) can redeliver.
      this.removeFromDedup(envelope.id);
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

    // Cache this envelope for future inReplyTo context lookups.
    // Stored after successful processing so the cache only contains legitimate messages.
    this.cacheEnvelope(envelope.id, senderIdentity, envelope.payload);

    // Notify heartbeat conditions (e.g. `when: agora_peer_message`) that a message arrived.
    if (this.onMessageProcessed) {
      try {
        this.onMessageProcessed();
      } catch { /* best-effort notification — never interrupt envelope processing */ }
    }

    return isUnprocessed ? 'unprocessed' : (injected ? 'injected' : 'queued');
  }

  /**
   * Extract a human-readable text excerpt from an envelope payload.
   * Used for F2 gate evaluation and envelope cache summaries.
   */
  private extractMessageText(payload: unknown): string {
    if (typeof payload === "string") {
      return payload.slice(0, 500);
    }
    if (payload && typeof payload === "object" && !Array.isArray(payload)) {
      const obj = payload as Record<string, unknown>;
      if (typeof obj.text === "string") {
        return obj.text.slice(0, 500);
      }
    }
    return JSON.stringify(payload).slice(0, 500);
  }

  /**
   * Add an envelope summary to the cache for inReplyTo context lookups.
   * Evicts the oldest entry when the cache is full.
   */
  private cacheEnvelope(envelopeId: string, senderMoniker: string, payload: unknown): void {
    if (this.envelopeCache.size >= AgoraMessageHandler.MAX_ENVELOPE_CACHE_SIZE) {
      const oldestKey = this.envelopeCache.keys().next().value;
      if (oldestKey !== undefined) {
        this.envelopeCache.delete(oldestKey);
      }
    }
    this.envelopeCache.set(envelopeId, {
      envelopeId,
      senderMoniker,
      text: this.extractMessageText(payload),
    });
  }

}
