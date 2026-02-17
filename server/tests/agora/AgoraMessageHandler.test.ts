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

// Mock implementations
class MockConversationManager implements IConversationManager {
  public appendedEntries: Array<{ role: AgentRole; entry: string }> = [];

  async append(role: AgentRole, entry: string): Promise<void> {
    this.appendedEntries.push({ role, entry });
  }
}

class MockMessageInjector implements IMessageInjector {
  public injectedMessages: string[] = [];

  injectMessage(message: string): void {
    this.injectedMessages.push(message);
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
}

class MockLogger implements ILogger {
  debug(_message: string): void {
    // No-op for testing
  }
}

class MockAgoraService implements IAgoraService {
  async sendMessage(_options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }) {
    return { ok: true, status: 200 };
  }

  async decodeInbound(_message: string) {
    return { ok: false, reason: "not implemented" };
  }

  getPeers() {
    return [];
  }

  getPeerConfig(_name: string) {
    return undefined;
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
  let getState: () => LoopState;
  let isRateLimited: () => boolean;

  beforeEach(() => {
    conversationManager = new MockConversationManager();
    messageInjector = new MockMessageInjector();
    eventSink = new MockEventSink();
    clock = new MockClock(new Date("2026-02-15T12:00:00Z"));
    agoraService = new MockAgoraService();
    logger = new MockLogger();
    getState = () => LoopState.RUNNING;
    isRateLimited = () => false;

    handler = new AgoraMessageHandler(
      agoraService,
      conversationManager,
      messageInjector,
      eventSink,
      clock,
      getState,
      isRateLimited,
      logger
    );
  });

  describe("processEnvelope", () => {
    const testEnvelope: Envelope = {
      id: "envelope-123",
      type: "request",
      sender: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
      timestamp: 1708000000000,
      payload: { question: "Hello?" },
      signature: "test-signature",
    };

    it("should write to CONVERSATION.md with correct format when RUNNING", async () => {
      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.role).toBe(AgentRole.SUBCONSCIOUS);
      expect(entry.entry).toContain("...cdefabcd");
      expect(entry.entry).toContain("request");
      expect(entry.entry).toContain("question");
      expect(entry.entry).not.toContain("[UNPROCESSED]");
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
        logger
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
        logger
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
        logger
      );

      await handler.processEnvelope(testEnvelope, "webhook");

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const entry = conversationManager.appendedEntries[0];
      expect(entry.entry).toContain("**[UNPROCESSED]**");
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
});
