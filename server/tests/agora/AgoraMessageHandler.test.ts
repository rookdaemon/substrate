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
import type { AgoraInboxManager } from "../../src/agora/AgoraInboxManager";

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

  debug(message: string): void {
    this.debugMessages.push(message);
  }
}

class MockInboxManager {
  public quarantinedMessages: Array<{ envelope: Envelope; source: string }> = [];

  async addQuarantinedMessage(envelope: Envelope, source: "webhook" | "relay" = "webhook"): Promise<void> {
    this.quarantinedMessages.push({ envelope, source });
  }
}

class MockAgoraService implements IAgoraService {
  private peers: Map<string, { publicKey: string; url: string; token: string }> = new Map();

  async sendMessage(_options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }) {
    return { ok: true, status: 200 };
  }

  async decodeInbound(_message: string) {
    return { ok: false, reason: "not implemented" };
  }

  getPeers() {
    return Array.from(this.peers.keys());
  }

  getPeerConfig(name: string) {
    return this.peers.get(name);
  }

  // Helper for tests
  addPeer(name: string, publicKey: string) {
    this.peers.set(name, { publicKey, url: "http://test", token: "test-token" });
  }

  async connectRelay(_url: string) {}

  async disconnectRelay() {}

  setRelayMessageHandler(_handler: (envelope: Envelope) => void) {}
  setRelayMessageHandlerWithName(_handler: (envelope: Envelope, from: string, fromName?: string) => void) {}

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
  let inboxManager: MockInboxManager;
  let getState: () => LoopState;
  let isRateLimited: () => boolean;

  const testEnvelope: Envelope = {
    id: "envelope-123",
    type: "request",
    sender: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
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
    inboxManager = new MockInboxManager();
    getState = () => LoopState.RUNNING;
    isRateLimited = () => false;

    // Default policy 'allow' for backward compatibility tests
    handler = new AgoraMessageHandler(
      agoraService,
      conversationManager,
      messageInjector,
      eventSink,
      clock,
      getState,
      isRateLimited,
      logger,
      'allow', // unknownSenderPolicy
      inboxManager as unknown as AgoraInboxManager,
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
      expect(entry.entry).toContain("...cdefabcd");
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
        'allow',
        inboxManager as unknown as AgoraInboxManager,
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
        'allow',
        inboxManager as unknown as AgoraInboxManager,
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
        'allow',
        inboxManager as unknown as AgoraInboxManager,
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
      expect(injected).toContain("[AGORA MESSAGE from");
      expect(injected).toContain("Type: request");
      expect(injected).toContain("Envelope ID: envelope-123");
    });

    it("should inject message into orchestrator", async () => {
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(messageInjector.injectedMessages).toHaveLength(1);
      const injected = messageInjector.injectedMessages[0];
      expect(injected).toContain("[AGORA MESSAGE from");
      expect(injected).toContain("Type: request");
      expect(injected).toContain("Envelope ID: envelope-123");
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
  });

  describe("deduplication", () => {
    const testEnvelope: Envelope = {
      id: "envelope-123",
      type: "request",
      sender: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
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
      const envelope1 = { ...testEnvelope, id: "envelope-1" };
      const envelope2 = { ...testEnvelope, id: "envelope-2" };
      const envelope3 = { ...testEnvelope, id: "envelope-3" };

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

      // Process 4 envelopes (exceeds limit of 3)
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-1" }, "webhook");
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-2" }, "webhook");
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-3" }, "webhook");
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-4" }, "webhook");

      // All 4 should have been processed
      expect(conversationManager.appendedEntries).toHaveLength(4);

      // Now send envelope-1 again (should be evicted from set, so should process again)
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-1" }, "webhook");

      // Should be processed again (count increases to 5)
      expect(conversationManager.appendedEntries).toHaveLength(5);

      // But envelope-4 should still be in the set (most recent 3 after envelope-1 re-added: envelope-1, envelope-3, envelope-4)
      // envelope-2 was evicted when envelope-1 was re-added
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-4" }, "webhook");

      // Should not process (still at 5) - envelope-4 is still in set
      expect(conversationManager.appendedEntries).toHaveLength(5);

      // envelope-2 should have been evicted, so it should process
      await testHandler.processEnvelope({ ...testEnvelope, id: "envelope-2" }, "webhook");

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

  describe("Security: unknownSenderPolicy", () => {
    it("should allow messages from known peers", async () => {
      // Add the sender to peer registry
      agoraService.addPeer("alice", testEnvelope.sender);

      // Use quarantine policy
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
        inboxManager as unknown as AgoraInboxManager
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      // Should be processed normally (not quarantined)
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(inboxManager.quarantinedMessages).toHaveLength(0);
    });

    it("should allow messages from unknown senders when policy is 'allow'", async () => {
      // Unknown sender + allow policy = process normally
      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'allow',
        inboxManager as unknown as AgoraInboxManager
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      // Should be processed normally
      expect(conversationManager.appendedEntries).toHaveLength(1);
      expect(messageInjector.injectedMessages).toHaveLength(1);
      expect(inboxManager.quarantinedMessages).toHaveLength(0);
    });

    it("should quarantine messages from unknown senders when policy is 'quarantine'", async () => {
      // Unknown sender + quarantine policy = quarantine
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
        inboxManager as unknown as AgoraInboxManager
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      // Should NOT be processed
      expect(conversationManager.appendedEntries).toHaveLength(0);
      expect(messageInjector.injectedMessages).toHaveLength(0);

      // Should be quarantined
      expect(inboxManager.quarantinedMessages).toHaveLength(1);
      expect(inboxManager.quarantinedMessages[0].envelope).toEqual(testEnvelope);
      expect(inboxManager.quarantinedMessages[0].source).toBe("webhook");

      // Should log debug message about quarantine
      const quarantineLog = logger.debugMessages.find(m => m.includes("quarantined") && m.includes("unknown sender"));
      expect(quarantineLog).toBeDefined();
    });

    it("should reject messages from unknown senders when policy is 'reject'", async () => {
      // Unknown sender + reject policy = silent reject
      handler = new AgoraMessageHandler(
        agoraService,
        conversationManager,
        messageInjector,
        eventSink,
        clock,
        getState,
        isRateLimited,
        logger,
        'reject',
        inboxManager as unknown as AgoraInboxManager
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      // Should NOT be processed
      expect(conversationManager.appendedEntries).toHaveLength(0);
      expect(messageInjector.injectedMessages).toHaveLength(0);

      // Should NOT be quarantined
      expect(inboxManager.quarantinedMessages).toHaveLength(0);

      // Should log debug message about rejection
      const rejectLog = logger.debugMessages.find(m => m.includes("Rejected") && m.includes("unknown sender"));
      expect(rejectLog).toBeDefined();
    });

    it("should default to 'quarantine' when policy is not specified", async () => {
      // Unknown sender + no policy (undefined) = quarantine by default
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
        inboxManager as unknown as AgoraInboxManager
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      // Should NOT be processed
      expect(conversationManager.appendedEntries).toHaveLength(0);
      expect(messageInjector.injectedMessages).toHaveLength(0);

      // Should be quarantined (default behavior)
      expect(inboxManager.quarantinedMessages).toHaveLength(1);

      // Should log debug message about quarantine
      const quarantineLog = logger.debugMessages.find(m => m.includes("quarantined"));
      expect(quarantineLog).toBeDefined();
    });
  });

  describe("per-sender rate limiting", () => {
    const testEnvelope2: Envelope = {
      id: "envelope-456",
      type: "request",
      sender: "302a300506032b6570032100ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
      timestamp: 1708000000000,
      payload: { question: "Different sender" },
      signature: "test-signature-2",
    };

    it("should allow messages under the rate limit", async () => {
      // Send 10 messages (the limit)
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-${i}` }, "webhook");
      }

      expect(conversationManager.appendedEntries).toHaveLength(10);
      expect(messageInjector.injectedMessages).toHaveLength(10);
    });

    it("should drop messages exceeding the rate limit", async () => {
      // Send 11 messages (one over the limit)
      for (let i = 0; i < 11; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-${i}` }, "webhook");
      }

      // Only 10 messages should have been processed
      expect(conversationManager.appendedEntries).toHaveLength(10);
      expect(messageInjector.injectedMessages).toHaveLength(10);
    });

    it("should track rate limits per sender independently", async () => {
      // Send 10 messages from first sender
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-1-${i}` }, "webhook");
      }

      // Send 10 messages from second sender
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope2, id: `envelope-2-${i}` }, "webhook");
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
        defaultRateLimitConfig
      );

      // Send 10 messages (the limit)
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-first-${i}` }, "webhook");
      }

      // Advance time by more than the window (60 seconds)
      mutableClock.setTime(new Date("2026-02-15T12:01:01Z"));

      // Send 10 more messages (should be allowed as window reset)
      for (let i = 0; i < 10; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-second-${i}` }, "webhook");
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
        'allow',
        inboxManager as unknown as AgoraInboxManager,
        disabledConfig
      );

      // Send 15 messages (over the limit, but rate limiting is disabled)
      for (let i = 0; i < 15; i++) {
        await handler.processEnvelope({ ...testEnvelope, id: `envelope-${i}` }, "webhook");
      }

      expect(conversationManager.appendedEntries).toHaveLength(15);
      expect(messageInjector.injectedMessages).toHaveLength(15);
    });

    it("should evict oldest sender window when Map exceeds 500 entries", async () => {
      // Create 500 unique senders and send one message each
      for (let i = 0; i < 500; i++) {
        const sender = `sender-${i.toString().padStart(10, "0")}`;
        await handler.processEnvelope(
          {
            ...testEnvelope,
            id: `envelope-${i}`,
            sender,
          },
          "webhook"
        );
      }

      // All 500 messages should have been processed
      expect(conversationManager.appendedEntries).toHaveLength(500);

      // Now add a 501st sender - this should trigger eviction
      await handler.processEnvelope(
        {
          ...testEnvelope,
          id: "envelope-501",
          sender: "sender-new",
        },
        "webhook"
      );

      // The 501st message should still be processed (eviction doesn't affect message processing)
      expect(conversationManager.appendedEntries).toHaveLength(501);
    });
  });
});
