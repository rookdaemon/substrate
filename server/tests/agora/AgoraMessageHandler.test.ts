import { AgoraMessageHandler } from "../../src/agora/AgoraMessageHandler";
import { IConversationManager } from "../../src/conversation/IConversationManager";
import { IMessageInjector } from "../../src/loop/IMessageInjector";
import { ILoopEventSink } from "../../src/loop/ILoopEventSink";
import { IClock } from "../../src/substrate/abstractions/IClock";
import { IAgoraService } from "../../src/agora/IAgoraService";
import { LoopState } from "../../src/loop/types";
import { AgentRole } from "../../src/agents/types";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import type { ILogger } from "../../src/logging";
import type { IFlashGate, F2Context, F1Context, FlashGateVerdict } from "../../src/gates/IFlashGate";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Mock implementations
class MockConversationManager implements IConversationManager {
  public appendedEntries: Array<{ role: AgentRole; entry: string }> = [];

  async append(role: AgentRole, entry: string): Promise<void> {
    this.appendedEntries.push({ role, entry });
  }
}

class MockMessageInjector implements IMessageInjector {
  public injectedMessages: string[] = [];
  public returnValue = true; // Default: simulate active session delivery

  injectMessage(message: string): boolean {
    this.injectedMessages.push(message);
    return this.returnValue;
  }
}

class MockEventSink implements ILoopEventSink {
  public events: Array<{ type: string; timestamp: string; data: unknown }> = [];

  emit(event: { type: string; timestamp: string; data: unknown }): void {
    this.events.push(event);
  }
}

class MockClock implements IClock {
  constructor(private currentTime: Date) {}

  now(): Date {
    return this.currentTime;
  }

  setTime(newTime: Date): void {
    this.currentTime = newTime;
  }
}

class MockLogger implements ILogger {
  public debugMessages: string[] = [];
  public verboseMessages: string[] = [];

  debug(message: string): void {
    this.debugMessages.push(message);
  }

  verbose(message: string): void {
    this.verboseMessages.push(message);
  }
}

class MockFlashGate implements IFlashGate {
  public lastF2Context?: F2Context;
  public lastF1Context?: F1Context;
  public f2Verdict: FlashGateVerdict = {
    verdict: "PROCEED",
    reasons: [],
    auto_block: false,
  };
  public f1Verdict: FlashGateVerdict = {
    verdict: "PROCEED",
    reasons: [],
  };
  public shouldThrow = false;
  public throwError = "Gate error";

  async evaluateInput(context: F2Context): Promise<FlashGateVerdict> {
    this.lastF2Context = context;
    if (this.shouldThrow) throw new Error(this.throwError);
    return this.f2Verdict;
  }

  async evaluateOutput(context: F1Context): Promise<FlashGateVerdict> {
    this.lastF1Context = context;
    if (this.shouldThrow) throw new Error(this.throwError);
    return this.f1Verdict;
  }
}

class MockAgoraService implements IAgoraService {
  // Keyed by publicKey to match agora v0.4.5 behaviour
  private peers: Map<string, { name: string; publicKey: string; url: string; token: string }> = new Map();

  async sendMessage(_options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }) {
    return { ok: true, status: 200 };
  }

  async replyToEnvelope(_options: { targetPubkey: string; type: string; payload: unknown; inReplyTo: string }) {
    return { ok: true, status: 0 };
  }

  async decodeInbound(_message: string) {
    return { ok: false, reason: "not implemented" };
  }

  getPeers() {
    return Array.from(this.peers.keys()); // returns public keys
  }

  getPeerConfig(identifier: string) {
    // resolve by public key (direct) or by name
    return this.peers.get(identifier)
      ?? Array.from(this.peers.values()).find(p => p.name === identifier);
  }

  // Helper for tests
  addPeer(name: string, publicKey: string) {
    this.peers.set(publicKey, { name, publicKey, url: "http://test", token: "test-token" });
  }

  getSelfIdentity() {
    return { publicKey: "302a300506032b6570032100selfselfselfselfselfselfselfselfselfselfselfself00000000", name: "nova" };
  }

  async connectRelay(_url: string) {}

  async disconnectRelay() {}

  isRelayConnected() {
    return false;
  }
}

describe("AgoraMessageHandler", () => {
  let handler: AgoraMessageHandler;
  let conversationManager: MockConversationManager;
  let messageInjector: MockMessageInjector;
  let eventSink: MockEventSink;
  let clock: MockClock;
  let agoraService: MockAgoraService;
  let logger: MockLogger;
  let getState: () => LoopState;
  let isRateLimited: () => boolean;

  const testEnvelope: Envelope = {
    id: "envelope-123",
    type: "request",
    from: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
    to: ["302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
    timestamp: 1708000000000,
    payload: { question: "Hello?" },
    signature: "test-signature",
  };

  const defaultRateLimitConfig = {
    enabled: true,
    maxMessages: 10,
    windowMs: 60000,
  };

  beforeEach(() => {
    conversationManager = new MockConversationManager();
    messageInjector = new MockMessageInjector();
    eventSink = new MockEventSink();
    clock = new MockClock(new Date("2026-02-15T12:00:00Z"));
    agoraService = new MockAgoraService();
    logger = new MockLogger();
    getState = () => LoopState.RUNNING;
    isRateLimited = () => false;

    // Default handler with a known peer registered (so messages pass the allowlist filter)
    agoraService.addPeer("test-peer", testEnvelope.from);
    handler = new AgoraMessageHandler(
      agoraService,
      conversationManager,
      messageInjector,
      eventSink,
      clock,
      getState,
      isRateLimited,
      logger,
      'quarantine',
      defaultRateLimitConfig
    );
  });

  describe("processEnvelope", () => {
    it("should write to CONVERSATION.md with correct format when RUNNING with active session", async () => {
      // messageInjector.returnValue = true (default) → active session, no [UNPROCESSED]
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.role).toBe(AgentRole.SUBCONSCIOUS);
      expect(entry.entry).toContain("**FROM:**");
      expect(entry.entry).toContain("**TO:**");
      expect(entry.entry).toContain("test-peer@cdefabcd");
      expect(entry.entry).not.toContain(testEnvelope.from);
      expect(entry.entry).toContain("question");
      expect(entry.entry).not.toContain("[UNPROCESSED]");
    });

    it("should add [UNPROCESSED] marker when RUNNING but no active session (between cycles)", async () => {
      // Simulate injection failing (between cycles — no active session)
      messageInjector.returnValue = false;

      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.entry).toContain("**[UNPROCESSED]**");
    });

    it("should add [UNPROCESSED] marker when STOPPED", async () => {
      getState = () => LoopState.STOPPED;
      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.entry).toContain("**[UNPROCESSED]**");
    });

    it("should add [UNPROCESSED] marker when PAUSED", async () => {
      getState = () => LoopState.PAUSED;
      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.entry).toContain("**[UNPROCESSED]**");
    });

    it("should add [UNPROCESSED] marker when rate-limited", async () => {
      getState = () => LoopState.RUNNING;
      const rateLimited = () => true;
      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        rateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.entry).toContain("**[UNPROCESSED]**");
    });

    it("should inject message into orchestrator before writing to CONVERSATION.md", async () => {
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(messageInjector.injectedMessages).toHaveLength(1);
      const injected = messageInjector.injectedMessages[0];
      expect(injected).toContain("[AGORA MESSAGE]");
      expect(injected).toContain("FROM:");
      expect(injected).toContain("TO:");
      expect(injected).toContain("test-peer@cdefabcd");
      expect(injected).toContain("Type: request");
      expect(injected).toContain("Envelope ID: envelope-123");
    });

    it("should inject message into orchestrator", async () => {
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(messageInjector.injectedMessages).toHaveLength(1);
      const injected = messageInjector.injectedMessages[0];
      expect(injected).toContain("[AGORA MESSAGE]");
      expect(injected).toContain("Type: request");
      expect(injected).toContain("Envelope ID: envelope-123");
    });

    it("should compact known inline @refs and include compact TO list in CONVERSATION entry", async () => {
      const envelopeWithMention: Envelope = {
        ...testEnvelope,
        payload: { text: `cc @${testEnvelope.from}` },
      };

      await handler.processEnvelope(envelopeWithMention, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0].entry;
      expect(entry).toContain("**FROM:**");
      expect(entry).toContain("**TO:**");
      expect(entry).toContain("@dddddddd");
      expect(entry).toContain("@test-peer@cdefabcd");
    });

    it("should emit WebSocket event", async () => {
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(eventSink.events).toHaveLength(1);
      const event = eventSink.events[0];
      expect(event.type).toBe("agora_message");
      expect(event.data).toMatchObject({
        envelopeId: "envelope-123",
        messageType: "request",
        source: "webhook",
      });
    });

    it("should handle relay source correctly", async () => {
      await handler.processEnvelope(testEnvelope, "relay");

      expect(eventSink.events[0].data).toMatchObject({
        source: "relay",
      });
    });

    it("should use registered peer name for relay messages (claimed names never surface)", async () => {
      await handler.processEnvelope(testEnvelope, "relay");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.entry).toContain("test-peer@cdefabcd");
      expect(entry.entry).not.toContain(testEnvelope.from);

      expect(messageInjector.injectedMessages).toHaveLength(1);
      const injected = messageInjector.injectedMessages[0];
      expect(injected).toContain("test-peer@cdefabcd");
      expect(injected).not.toContain(testEnvelope.from);
    });
  });

  describe("deduplication", () => {
    const testEnvelope: Envelope = {
      id: "envelope-123",
      type: "request",
      from: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      to: ["302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
      timestamp: 1708000000000,
      payload: { question: "Hello?" },
      signature: "test-signature",
    };

    it("should not process duplicate envelope twice", async () => {
      // First call - should process
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(eventSink.events).toHaveLength(1);

      // Second call with same envelope ID - should skip
      await handler.processEnvelope(testEnvelope, "webhook");

      // Counts should not increase
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(eventSink.events).toHaveLength(1);
    });

    it("should process different envelope IDs", async () => {
      const envelope1 = { ...testEnvelope, id: "envelope-1", payload: { question: "Hello 1?" } };
      const envelope2 = { ...testEnvelope, id: "envelope-2", payload: { question: "Hello 2?" } };
      const envelope3 = { ...testEnvelope, id: "envelope-3", payload: { question: "Hello 3?" } };

      await handler.processEnvelope(envelope1, "webhook");
      await handler.processEnvelope(envelope2, "webhook");
      await handler.processEnvelope(envelope3, "webhook");

      // All three should be processed
      expect(conversationManager.appendedEntries).toHaveLength(3);
      expect(messageInjector.injectedMessages).toHaveLength(3);
      expect(eventSink.events).toHaveLength(3);
    });

    it("should evict oldest entry when MAX_DEDUP_SIZE exceeded", async () => {
      // Create a handler with a small MAX_DEDUP_SIZE for testing
      // We'll use reflection to set a smaller size
      const testHandler = new AgoraMessageHandler(

        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'allow'  // bypass allowlist check — this test is specifically about dedup eviction mechanics
      );

      // Override MAX_DEDUP_SIZE to 3 for testing
      (testHandler as unknown as { MAX_DEDUP_SIZE: number }).MAX_DEDUP_SIZE = 3;

      // Process 4 envelopes (exceeds limit of 3) — each needs unique payload to avoid content dedup
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-1", payload: { n: 1 } }, "webhook");
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-2", payload: { n: 2 } }, "webhook");
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-3", payload: { n: 3 } }, "webhook");
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-4", payload: { n: 4 } }, "webhook");

      // All 4 should have been processed
      expect(conversationManager.appendedEntries).toHaveLength(4);

      // Now send envelope-1 again (should be evicted from envelope ID set, so should process again)
      // Use same payload as original envelope-1 — content dedup has 30min window but envelope ID dedup is the focus here
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-1", payload: { n: 1, retry: true } }, "webhook");

      // Should be processed again (count increases to 5)
      expect(conversationManager.appendedEntries).toHaveLength(5);

      // But envelope-4 should still be in the set (most recent 3 after envelope-1 re-added: envelope-1, envelope-3, envelope-4)
      // envelope-2 was evicted when envelope-1 was re-added
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-4", payload: { n: 4, retry: true } }, "webhook");

      // Should not process (still at 5) - envelope-4 is still in envelope ID set
      expect(conversationManager.appendedEntries).toHaveLength(5);

      // envelope-2 should have been evicted, so it should process
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-2", payload: { n: 2, retry: true } }, "webhook");

      // Should process (count increases to 6)
      expect(conversationManager.appendedEntries).toHaveLength(6);
    });

    it("should deduplicate regardless of source (webhook vs relay)", async () => {
      // First call via webhook
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);

      // Second call via relay with same envelope ID - should skip
      await handler.processEnvelope(testEnvelope, "relay");

      // Count should not increase
      expect(conversationManager.appendedEntries).toHaveLength(1);
    });
  });

  describe("content-based dedup (#238)", () => {
    const announceEnvelope: Envelope = {
      id: "announce-1",
      type: "announce",
      from: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      to: ["302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
      timestamp: 1708000000000,
      payload: { name: "kuro", version: "1.0.0", capabilities: ["crypto_analysis"] },
      signature: "test-signature",
    };

    it("should skip duplicate content from same sender within 30-minute window", async () => {
      const env1 = { ...announceEnvelope, id: "announce-1" };
      const env2 = { ...announceEnvelope, id: "announce-2" }; // Different ID, same content

      await handler.processEnvelope(env1, "relay");
      await handler.processEnvelope(env2, "relay");

      // Only the first should be processed
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(messageInjector.injectedMessages).toHaveLength(1);
    });

    it("should allow same content after window expires", async () => {
      const mutableClock = new MockClock(new Date("2026-02-15T12:00:00Z"));
      const windowHandler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        mutableClock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig
      );

      await windowHandler.processEnvelope({ ...announceEnvelope, id: "a-1" }, "relay");
      expect(conversationManager.appendedEntries).toHaveLength(1);

      // Advance clock past 30-minute window
      mutableClock.setTime(new Date("2026-02-15T12:31:00Z"));

      await windowHandler.processEnvelope({ ...announceEnvelope, id: "a-2" }, "relay");
      expect(conversationManager.appendedEntries).toHaveLength(2);
    });

    it("should allow different content from same sender", async () => {
      const env1 = { ...announceEnvelope, id: "a-1" };
      const env2 = { ...announceEnvelope, id: "a-2", payload: { name: "kuro", version: "2.0.0" } };

      await handler.processEnvelope(env1, "relay");
      await handler.processEnvelope(env2, "relay");

      expect(conversationManager.appendedEntries).toHaveLength(2);
    });

    it("should allow same content from different senders", async () => {
      const sender2 = "302a300506032b6570032100ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
      agoraService.addPeer("other-peer", sender2);

      const env1 = { ...announceEnvelope, id: "a-1" };
      const env2 = { ...announceEnvelope, id: "a-2", from: sender2 };

      await handler.processEnvelope(env1, "relay");
      await handler.processEnvelope(env2, "relay");

      expect(conversationManager.appendedEntries).toHaveLength(2);
    });

    it("should deduplicate non-announce message types too", async () => {
      const request1: Envelope = {
        id: "req-1",
        type: "request",
        from: announceEnvelope.from,
        to: announceEnvelope.to,
        timestamp: 1708000000000,
        payload: { question: "same question" },
        signature: "test-sig",
      };
      const request2 = { ...request1, id: "req-2" };

      await handler.processEnvelope(request1, "relay");
      await handler.processEnvelope(request2, "relay");

      expect(conversationManager.appendedEntries).toHaveLength(1);
    });

    it("should log dedup event with hash prefix", async () => {
      await handler.processEnvelope({ ...announceEnvelope, id: "a-1" }, "relay");
      await handler.processEnvelope({ ...announceEnvelope, id: "a-2" }, "relay");

      const dedupLog = logger.debugMessages.find(m => m.includes("Duplicate content") && m.includes("#238"));
      expect(dedupLog).toBeDefined();
    });

    it("should treat different message types as different content", async () => {
      const asAnnounce = { ...announceEnvelope, id: "a-1", type: "announce" };
      const asPublish = { ...announceEnvelope, id: "a-2", type: "publish" };

      await handler.processEnvelope(asAnnounce, "relay");
      await handler.processEnvelope(asPublish, "relay");

      expect(conversationManager.appendedEntries).toHaveLength(2);
    });
  });

  describe("Security: peer allowlist", () => {
    it("should allow messages from known peers", async () => {
      // testEnvelope.from is already registered as "test-peer" in beforeEach
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(messageInjector.injectedMessages).toHaveLength(1);
    });

    it("should silently drop messages from unknown senders (policy: reject)", async () => {
      // Use a fresh agoraService with no peers registered
      const emptyAgoraService = new MockAgoraService();
      const filteredHandler = new AgoraMessageHandler(
        emptyAgoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'reject',
        defaultRateLimitConfig
      );

      await filteredHandler.processEnvelope(testEnvelope, "webhook");

      // Should NOT be processed
      expect(conversationManager.appendedEntries).toHaveLength(0);
      expect(messageInjector.injectedMessages).toHaveLength(0);

      // Should log debug message about rejecting
      const filterLog = logger.debugMessages.find(m => m.includes("Rejected") && m.includes("unknown sender"));
      expect(filterLog).toBeDefined();
    });
  });

  describe("Security: unknownSenderPolicy", () => {
    const unknownEnvelope: Envelope = {
      id: "unknown-envelope-123",
      type: "request",
      from: "302a300506032b6570032100eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
      to: ["302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
      timestamp: 1708000000000,
      payload: { message: "Hello from unknown" },
      signature: "test-signature-unknown",
    };

    it("should reject and discard messages from unknown senders when policy is 'reject'", async () => {
      const emptyAgoraService = new MockAgoraService();
      const rejectHandler = new AgoraMessageHandler(
        emptyAgoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'reject',
        defaultRateLimitConfig
      );

      await rejectHandler.processEnvelope(unknownEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(0);
      expect(messageInjector.injectedMessages).toHaveLength(0);
      const rejectLog = logger.debugMessages.find(m => m.includes("Rejected") && m.includes("unknown sender"));
      expect(rejectLog).toBeDefined();
    });

    it("should quarantine messages from unknown senders when policy is 'quarantine'", async () => {
      const emptyAgoraService = new MockAgoraService();
      const quarantineHandler = new AgoraMessageHandler(
        emptyAgoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig
      );

      await quarantineHandler.processEnvelope(unknownEnvelope, "webhook");

      // Written to CONVERSATION.md with [UNPROCESSED] badge but NOT injected
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).toContain("**[UNPROCESSED]**");
      expect(conversationManager.appendedEntries[0].entry).toContain("**FROM:**");
      expect(conversationManager.appendedEntries[0].entry).toContain("**TO:**");
      expect(conversationManager.appendedEntries[0].entry).toContain("@eeeeeeee");
      expect(messageInjector.injectedMessages).toHaveLength(0);
      const quarantineLog = logger.debugMessages.find(m => m.includes("Quarantining") && m.includes("unknown sender"));
      expect(quarantineLog).toBeDefined();
    });

    it("should allow and inject messages from unknown senders when policy is 'allow'", async () => {
      const emptyAgoraService = new MockAgoraService();
      const allowHandler = new AgoraMessageHandler(
        emptyAgoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'allow',
        defaultRateLimitConfig
      );

      await allowHandler.processEnvelope(unknownEnvelope, "webhook");

      // Processed normally - injected and written to CONVERSATION.md without UNPROCESSED badge
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).not.toContain("**[UNPROCESSED]**");
      const allowLog = logger.debugMessages.find(m => m.includes("Allowing") && m.includes("unknown sender"));
      expect(allowLog).toBeDefined();
    });

    it("should use 'quarantine' policy by default (no policy specified)", async () => {
      const emptyAgoraService = new MockAgoraService();
      const defaultHandler = new AgoraMessageHandler(
        emptyAgoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger
        // no policy specified → defaults to 'quarantine'
      );

      await defaultHandler.processEnvelope(unknownEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).toContain("**[UNPROCESSED]**");
      expect(messageInjector.injectedMessages).toHaveLength(0);
    });

    it("should include moniker-based to reply instruction for unknown senders with 'allow' policy", async () => {
      const emptyAgoraService = new MockAgoraService();
      const allowHandler = new AgoraMessageHandler(
        emptyAgoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'allow',
        defaultRateLimitConfig
      );

      await allowHandler.processEnvelope(unknownEnvelope, "webhook");

      expect(messageInjector.injectedMessages).toHaveLength(1);
      const injectedMsg = messageInjector.injectedMessages[0];
      // Unknown senders should still be replied to using verified moniker form.
      expect(injectedMsg).toContain('to="@');
      expect(injectedMsg).not.toContain("not possible");
      expect(injectedMsg).not.toContain("unless the peer is added first");
      expect(injectedMsg).not.toContain("targetPubkey");
    });

    it("should include to reply instruction for known senders", async () => {
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(messageInjector.injectedMessages).toHaveLength(1);
      const injectedMsg = messageInjector.injectedMessages[0];
      // Should contain to instruction, not targetPubkey
      expect(injectedMsg).toContain('to=');
      expect(injectedMsg).not.toContain("targetPubkey");
    });
  });

  describe("per-sender rate limiting", () => {
    const testEnvelope2: Envelope = {
      id: "envelope-456",
      type: "request",
      from: "302a300506032b6570032100ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      to: ["302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
      timestamp: 1708000000000,
      payload: { question: "Different sender" },
      signature: "test-signature-2",
    };

    beforeEach(() => {
      // Register testEnvelope2's sender as a known peer
      agoraService.addPeer("test-peer-2", testEnvelope2.from);
    });

    it("should allow messages under the rate limit", async () => {
      // Send 10 messages (the limit) — each needs unique payload to avoid content dedup
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-${i}`, payload: { n: i } }, "webhook");
      }

      expect(conversationManager.appendedEntries).toHaveLength(10);
      expect(messageInjector.injectedMessages).toHaveLength(10);
    });

    it("should drop messages exceeding the rate limit", async () => {
      // Send 11 messages (one over the limit) — unique payloads
      for (let i = 0; i < 11; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-${i}`, payload: { n: i } }, "webhook");
      }

      // Only 10 messages should have been processed
      expect(conversationManager.appendedEntries).toHaveLength(10);
      expect(messageInjector.injectedMessages).toHaveLength(10);
    });

    it("should track rate limits per sender independently", async () => {
      // Send 10 messages from first sender — unique payloads
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-1-${i}`, payload: { n: i } }, "webhook");
      }

      // Send 10 messages from second sender — unique payloads
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope2, id: `envelope-2-${i}`, payload: { n: i } }, "webhook");
      }

      // Both senders should have all messages processed
      expect(conversationManager.appendedEntries).toHaveLength(20);
      expect(messageInjector.injectedMessages).toHaveLength(20);
    });

    it("should reset rate limit window after time expires", async () => {
      const mutableClock = new MockClock(new Date("2026-02-15T12:00:00Z"));
      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        mutableClock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig
      );

      // Send 10 messages (the limit) — unique payloads
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-first-${i}`, payload: { n: i } }, "webhook");
      }

      // Advance time by more than the window (60 seconds)
      mutableClock.setTime(new Date("2026-02-15T12:01:01Z"));

      // Send 10 more messages (should be allowed as window reset) — unique payloads
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-second-${i}`, payload: { n: i + 100 } }, "webhook");
      }

      expect(conversationManager.appendedEntries).toHaveLength(20);
      expect(messageInjector.injectedMessages).toHaveLength(20);
    });

    it("should not rate limit when disabled in config", async () => {
      const disabledConfig = {
        enabled: false,
        maxMessages: 10,
        windowMs: 60000,
      };

      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        disabledConfig
      );

      // Send 15 messages (over the limit, but rate limiting is disabled) — unique payloads
      for (let i = 0; i < 15; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-${i}`, payload: { n: i } }, "webhook");
      }

      expect(conversationManager.appendedEntries).toHaveLength(15);
      expect(messageInjector.injectedMessages).toHaveLength(15);
    });

    it("should evict oldest sender window when Map exceeds 500 entries", async () => {
      // Create 500 unique senders and send one message each
      for (let i = 0; i < 500; i++) {
        const sender = `sender-${i.toString().padStart(10, "0")}`;
        agoraService.addPeer(`peer-${i}`, sender);
        await handler.processEnvelope(
          {
            ...testEnvelope,
            id: `envelope-${i}`,
            from: sender,
            to: testEnvelope.to,
          },
          "webhook"
        );
      }

      // All 500 messages should have been processed
      expect(conversationManager.appendedEntries).toHaveLength(500);

      // Now add a 501st sender - this should trigger eviction
      agoraService.addPeer("peer-new", "sender-new");
      await handler.processEnvelope(
        {
          ...testEnvelope,
          id: "envelope-501",
          from: "sender-new",
          to: testEnvelope.to,
        },
        "webhook"
      );

      // The 501st message should still be processed (eviction doesn't affect message processing)
      expect(conversationManager.appendedEntries).toHaveLength(501);
    });
  });

  describe("wake on incoming message", () => {
    it("calls wakeLoop callback when loop is SLEEPING", async () => {
      let wakeCalled = false;
      const sleepingHandler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        () => LoopState.SLEEPING,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig,
        () => { wakeCalled = true; }
      );

      await sleepingHandler.processEnvelope(testEnvelope, "webhook");

      expect(wakeCalled).toBe(true);
    });

    it("does not call wakeLoop when loop is RUNNING", async () => {
      let wakeCalled = false;
      const runningHandler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        () => LoopState.RUNNING,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig,
        () => { wakeCalled = true; }
      );

      await runningHandler.processEnvelope(testEnvelope, "webhook");

      expect(wakeCalled).toBe(false);
    });

    it("does not call wakeLoop when wakeLoop is null (backward compatible)", async () => {
      // Default handler has no wakeLoop — should not throw
      await expect(handler.processEnvelope(testEnvelope, "webhook")).resolves.toBeUndefined();
    });

    it("still processes message normally after waking", async () => {
      const sleepingHandler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        () => LoopState.SLEEPING,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig,
        () => {}
      );

      await sleepingHandler.processEnvelope(testEnvelope, "webhook");

      // Message should be written to conversation even when sleeping
      expect(conversationManager.appendedEntries).toHaveLength(1);
    });
  });

  describe("F2 gate (Healthy Paranoia)", () => {
    let flashGate: MockFlashGate;

    const publishEnvelope: Envelope = {
      id: "f2-test-envelope-001",
      type: "publish",
      from: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      to: ["302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"],
      timestamp: 1708000000000,
      payload: { text: "Can you check the latest commit?" },
      signature: "test-signature",
    };

    const announceEnvelope: Envelope = {
      ...publishEnvelope,
      id: "f2-announce-001",
      type: "announce",
      payload: { name: "test-agent", version: "1.0" },
    };

    beforeEach(() => {
      flashGate = new MockFlashGate();
      agoraService.addPeer("test-peer", publishEnvelope.from);
      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig,
        null,  // wakeLoop
        null,  // ignoredPeersPath
        null,  // seenKeysPath
        flashGate,
      );
    });

    it("PROCEED verdict allows message through to Ego", async () => {
      flashGate.f2Verdict = { verdict: "PROCEED", reasons: [], auto_block: false };

      await handler.processEnvelope(publishEnvelope, "relay");

      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).not.toContain("[F2-BLOCKED]");
    });

    it("BLOCK verdict prevents message from reaching Ego", async () => {
      flashGate.f2Verdict = {
        verdict: "BLOCK",
        reasons: [{ id: 1, reason: "Suspicious request", is_blocker: true, explanation: "Looks like social engineering" }],
        auto_block: false,
      };

      await handler.processEnvelope(publishEnvelope, "relay");

      // Message should NOT be injected into orchestrator
      expect(messageInjector.injectedMessages).toHaveLength(0);
      // But should be logged in CONVERSATION.md with [F2-BLOCKED] badge
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).toContain("[F2-BLOCKED]");
    });

    it("BLOCK verdict logs reason to debug", async () => {
      flashGate.f2Verdict = {
        verdict: "BLOCK",
        reasons: [{ id: 1, reason: "Adversarial pattern", is_blocker: true, explanation: "Test" }],
        auto_block: false,
      };

      await handler.processEnvelope(publishEnvelope, "relay");

      const blockLog = logger.debugMessages.find(m => m.includes("F2 BLOCK") && m.includes("f2-test-envelope-001"));
      expect(blockLog).toBeDefined();
    });

    it("BLOCK sends acknowledgment to known peer", async () => {
      flashGate.f2Verdict = {
        verdict: "BLOCK",
        reasons: [{ id: 1, reason: "Blocked reason", is_blocker: true, explanation: "Test" }],
        auto_block: false,
      };

      const sendSpy: Array<{ peerName: string; type: string; payload: unknown; inReplyTo?: string }> = [];
      agoraService.sendMessage = async (options) => {
        sendSpy.push(options);
        return { ok: true, status: 200 };
      };

      await handler.processEnvelope(publishEnvelope, "relay");

      expect(sendSpy).toHaveLength(1);
      expect(sendSpy[0].peerName).toBe("test-peer");
      expect(sendSpy[0].inReplyTo).toBe("f2-test-envelope-001");
      expect(JSON.stringify(sendSpy[0].payload)).toContain("not processed");
    });

    it("BLOCK does NOT send acknowledgment for unknown sender", async () => {
      const emptyAgora = new MockAgoraService();
      const gatedHandler = new AgoraMessageHandler(
        emptyAgora,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'allow',
        defaultRateLimitConfig,
        null, null, null,
        flashGate,
      );

      flashGate.f2Verdict = {
        verdict: "BLOCK",
        reasons: [{ id: 1, reason: "Blocked", is_blocker: true, explanation: "Test" }],
        auto_block: false,
      };

      const sendSpy: unknown[] = [];
      emptyAgora.sendMessage = async (options) => {
        sendSpy.push(options);
        return { ok: true, status: 200 };
      };

      await gatedHandler.processEnvelope(publishEnvelope, "relay");

      // No ack sent — unknown sender
      expect(sendSpy).toHaveLength(0);
    });

    it("auto-BLOCK records auto_block_reason in log", async () => {
      flashGate.f2Verdict = {
        verdict: "BLOCK",
        reasons: [],
        auto_block: true,
        auto_block_reason: 'Unverified sender requested irreversible action (keyword: "delete")',
      };

      await handler.processEnvelope(publishEnvelope, "relay");

      const blockLog = logger.debugMessages.find(m => m.includes("F2 BLOCK") && m.includes("delete"));
      expect(blockLog).toBeDefined();
    });

    it("ESCALATE verdict injects message with escalation flag", async () => {
      flashGate.f2Verdict = {
        verdict: "ESCALATE",
        reasons: [{ id: 1, reason: "Uncertain intent", is_blocker: true, explanation: "Could be legitimate or adversarial" }],
      };

      await handler.processEnvelope(publishEnvelope, "relay");

      // Message SHOULD be injected (ESCALATE passes to Ego with flag)
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(messageInjector.injectedMessages[0]).toContain("[F2-ESCALATE]");
      expect(messageInjector.injectedMessages[0]).toContain("Uncertain intent");
    });

    it("does NOT apply F2 gate to announce messages", async () => {
      await handler.processEnvelope(announceEnvelope, "relay");

      // Gate should not have been called
      expect(flashGate.lastF2Context).toBeUndefined();
      // Message should still be processed normally
      expect(conversationManager.appendedEntries).toHaveLength(1);
    });

    it("does NOT apply F2 gate to non-gated message types", async () => {
      const ackEnvelope: Envelope = {
        ...publishEnvelope,
        id: "f2-ack-001",
        type: "ack",
        payload: { text: "acknowledged" },
      };

      await handler.processEnvelope(ackEnvelope, "relay");

      expect(flashGate.lastF2Context).toBeUndefined();
    });

    it("applies F2 gate to request messages", async () => {
      const requestEnvelope: Envelope = {
        ...publishEnvelope,
        id: "f2-request-001",
        type: "request",
        payload: { text: "What is the current status?" },
      };

      await handler.processEnvelope(requestEnvelope, "relay");

      expect(flashGate.lastF2Context).toBeDefined();
      expect(flashGate.lastF2Context!.message_type).toBe("request");
    });

    it("passes correct context to F2 gate", async () => {
      await handler.processEnvelope(publishEnvelope, "relay");

      expect(flashGate.lastF2Context).toBeDefined();
      expect(flashGate.lastF2Context!.sender_verified).toBe(true);
      expect(flashGate.lastF2Context!.sender_moniker).toContain("test-peer");
      expect(flashGate.lastF2Context!.message_text).toBe("Can you check the latest commit?");
      expect(flashGate.lastF2Context!.message_type).toBe("publish");
      expect(flashGate.lastF2Context!.envelope_id).toBe("f2-test-envelope-001");
    });

    it("passes sender_verified=false for unknown senders", async () => {
      const emptyAgora = new MockAgoraService();
      const gatedHandler = new AgoraMessageHandler(
        emptyAgora,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'allow',
        defaultRateLimitConfig,
        null, null, null,
        flashGate,
      );

      await gatedHandler.processEnvelope(publishEnvelope, "relay");

      expect(flashGate.lastF2Context).toBeDefined();
      expect(flashGate.lastF2Context!.sender_verified).toBe(false);
    });

    it("defaults to BLOCK when gate throws an exception", async () => {
      flashGate.shouldThrow = true;
      flashGate.throwError = "Vertex API timeout";

      await handler.processEnvelope(publishEnvelope, "relay");

      // Should be blocked (gate error → BLOCK per spec)
      expect(messageInjector.injectedMessages).toHaveLength(0);
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(conversationManager.appendedEntries[0].entry).toContain("[F2-BLOCKED]");
      const errorLog = logger.debugMessages.find(m => m.includes("F2 gate error") && m.includes("Vertex API timeout"));
      expect(errorLog).toBeDefined();
    });

    it("works without F2 gate (null — backward compatible)", async () => {
      // Default handler has no flashGate
      const noGateHandler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig,
      );

      await noGateHandler.processEnvelope(publishEnvelope, "relay");

      // Should process normally without gate
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(conversationManager.appendedEntries).toHaveLength(1);
    });

    it("extracts text from complex payload for gate context", async () => {
      const complexEnvelope: Envelope = {
        ...publishEnvelope,
        id: "f2-complex-001",
        payload: { data: [1, 2, 3], nested: { key: "value" } },
      };

      await handler.processEnvelope(complexEnvelope, "relay");

      expect(flashGate.lastF2Context).toBeDefined();
      // No .text field → should JSON.stringify the payload
      expect(flashGate.lastF2Context!.message_text).toContain("data");
      expect(flashGate.lastF2Context!.message_text).toContain("nested");
    });
  });

  describe("Dedup persistence: getProcessedEnvelopeIds / setProcessedEnvelopeIds", () => {
    it("ignorePeer adds sender to blocklist and processEnvelope drops early", async () => {
      const added = handler.ignorePeer(testEnvelope.from);
      expect(added).toBe(true);

      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(0);
      expect(messageInjector.injectedMessages).toHaveLength(0);
      expect(eventSink.events).toHaveLength(0);
    });

    it("unignorePeer removes sender and processing resumes", async () => {
      handler.ignorePeer(testEnvelope.from);
      const removed = handler.unignorePeer(testEnvelope.from);
      expect(removed).toBe(true);

      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(eventSink.events).toHaveLength(1);
    });

    it("listIgnoredPeers returns sorted blocklist", () => {
      handler.ignorePeer("peer-z");
      handler.ignorePeer("peer-a");

      expect(handler.listIgnoredPeers()).toEqual(["peer-a", "peer-z"]);
    });

    it("loads ignored peers from persistence file at startup", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "substrate-ignored-"));
      const ignoredPath = join(tempDir, "IGNORED_PEERS.md");
      try {
        writeFileSync(
          ignoredPath,
          [
            "# Ignored peers",
            "peer-b",
            "peer-a",
            "",
          ].join("\n"),
          "utf-8",
        );

        const handlerWithPersistence = new AgoraMessageHandler(
          agoraService,
          conversationManager,
          messageInjector,
          eventSink,
          clock,
          getState,
          isRateLimited,
          logger,
          'quarantine',
          defaultRateLimitConfig,
          null,
          ignoredPath,
        );

        expect(handlerWithPersistence.listIgnoredPeers()).toEqual(["peer-a", "peer-b"]);
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("persists blocklist changes when ignore/unignore are called", () => {
      const tempDir = mkdtempSync(join(tmpdir(), "substrate-ignored-"));
      const ignoredPath = join(tempDir, "IGNORED_PEERS.md");
      try {
        const handlerWithPersistence = new AgoraMessageHandler(
          agoraService,
          conversationManager,
          messageInjector,
          eventSink,
          clock,
          getState,
          isRateLimited,
          logger,
          'quarantine',
          defaultRateLimitConfig,
          null,
          ignoredPath,
        );

        handlerWithPersistence.ignorePeer("peer-z");
        handlerWithPersistence.ignorePeer("peer-a");
        handlerWithPersistence.unignorePeer("peer-z");

        const persisted = readFileSync(ignoredPath, "utf-8");
        expect(persisted).toContain("# Ignored peers");
        expect(persisted).toContain("peer-a");
        expect(persisted).not.toContain("peer-z");
      } finally {
        rmSync(tempDir, { recursive: true, force: true });
      }
    });

    it("getProcessedEnvelopeIds returns empty array when no envelopes processed", () => {
      expect(handler.getProcessedEnvelopeIds()).toEqual([]);
    });

    it("getProcessedEnvelopeIds returns IDs of processed envelopes", async () => {
      await handler.processEnvelope(testEnvelope, "webhook");

      const ids = handler.getProcessedEnvelopeIds();
      expect(ids).toContain(testEnvelope.id);
      expect(ids).toHaveLength(1);
    });

    it("setProcessedEnvelopeIds restores known IDs so duplicates are rejected", async () => {
      // Pre-load the dedup set with the test envelope ID
      handler.setProcessedEnvelopeIds([testEnvelope.id]);

      // Now try to process the same envelope — should be skipped as a duplicate
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(0);
    });

    it("setProcessedEnvelopeIds trims to MAX_DEDUP_SIZE keeping the tail", () => {
      // Create more than MAX_DEDUP_SIZE (1000) IDs
      const many = Array.from({ length: 1100 }, (_, i) => `id-${i}`);
      handler.setProcessedEnvelopeIds(many);

      const stored = handler.getProcessedEnvelopeIds();
      expect(stored).toHaveLength(1000);
      // The tail (most-recent) IDs should be retained
      expect(stored).toContain("id-1099");
      expect(stored).not.toContain("id-0");
    });

    it("getProcessedEnvelopeIds round-trips through setProcessedEnvelopeIds", async () => {
      const env2: Envelope = { ...testEnvelope, id: "envelope-456" };
      await handler.processEnvelope(testEnvelope, "webhook");
      await handler.processEnvelope(env2, "webhook");

      const snapshot = handler.getProcessedEnvelopeIds();

      // Create a fresh handler and restore the snapshot
      const handler2 = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'quarantine',
        defaultRateLimitConfig
      );
      handler2.setProcessedEnvelopeIds(snapshot);

      // Both IDs should be treated as duplicates on the restored handler
      const before = conversationManager.appendedEntries.length;
      await handler2.processEnvelope(testEnvelope, "webhook");
      await handler2.processEnvelope(env2, "webhook");
      expect(conversationManager.appendedEntries.length).toBe(before);
    });
  });
});
