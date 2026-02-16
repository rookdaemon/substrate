import { AgoraProvider } from "../../../src/tinybus/providers/AgoraProvider";
import { createMessage, Message } from "../../../src/tinybus/core/Message";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { AgoraInboxManager } from "../../../src/agora/AgoraInboxManager";
import { ILoopEventSink } from "../../../src/loop/ILoopEventSink";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

// Mock Agora Service
interface AgoraServiceType {
  sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }): Promise<{ ok: boolean; status: number; error?: string }>;
  decodeInbound(message: string): Promise<{ ok: boolean; envelope?: Envelope; reason?: string }>;
  getPeers(): string[];
  getPeerConfig(name: string): { publicKey: string; url: string; token: string } | undefined;
  connectRelay(url: string): Promise<void>;
  disconnectRelay(): Promise<void>;
  setRelayMessageHandler(handler: (envelope: Envelope) => void): void;
  isRelayConnected(): boolean;
}

class MockAgoraService implements AgoraServiceType {
  public sentMessages: Array<{ peerName: string; type: string; payload: unknown; inReplyTo?: string }> = [];
  public shouldFailSend = false;
  private relayConnected = false;

  async sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }) {
    if (this.shouldFailSend) {
      return { ok: false, status: 500, error: "Mock error" };
    }
    this.sentMessages.push(options);
    return { ok: true, status: 200 };
  }

  async decodeInbound(_message: string) {
    return { ok: false, reason: "not implemented in mock" };
  }

  getPeers() {
    return ["test-peer"];
  }

  getPeerConfig(_name: string) {
    return undefined;
  }

  async connectRelay(_url: string) {
    this.relayConnected = true;
  }

  async disconnectRelay() {
    this.relayConnected = false;
  }

  setRelayMessageHandler(_handler: (envelope: Envelope) => void) {}

  isRelayConnected() {
    return this.relayConnected;
  }
}

// Mock Event Sink
class MockEventSink implements ILoopEventSink {
  public events: Array<{ type: string; timestamp: string; data: unknown }> = [];

  emit(event: { type: string; timestamp: string; data: unknown }): void {
    this.events.push(event);
  }
}

describe("AgoraProvider", () => {
  let provider: AgoraProvider;
  let agoraService: MockAgoraService;
  let appendWriter: AppendOnlyWriter;
  let agoraInboxManager: AgoraInboxManager;
  let eventSink: MockEventSink;
  let clock: FixedClock;
  let fs: InMemoryFileSystem;
  let messageHandler: jest.Mock<Promise<void>, [Message]>;

  beforeEach(() => {
    // Set up test environment
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-16T18:00:00Z"));
    const config = new SubstrateConfig("/test/substrate");
    const lock = new FileLock();
    appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    agoraInboxManager = new AgoraInboxManager(fs, config, lock, clock);
    eventSink = new MockEventSink();
    agoraService = new MockAgoraService();
    messageHandler = jest.fn().mockResolvedValue(undefined);

    // Create provider with mock service
    provider = new AgoraProvider(
      agoraService,
      appendWriter,
      agoraInboxManager,
      eventSink,
      clock
    );
    provider.onMessage(messageHandler);
  });

  describe("initialization", () => {
    it("has correct id", () => {
      expect(provider.id).toBe("agora");
    });

    it("is not ready before start", async () => {
      expect(await provider.isReady()).toBe(false);
    });

    it("returns correct message types", () => {
      const types = provider.getMessageTypes();
      expect(types).toEqual(["agora.peer.message", "agora.relay.message", "agora.send"]);
    });
  });

  describe("lifecycle", () => {
    it("becomes ready after start when service is configured", async () => {
      await provider.start();
      expect(await provider.isReady()).toBe(true);
    });

    it("becomes not ready after stop", async () => {
      await provider.start();
      await provider.stop();
      expect(await provider.isReady()).toBe(false);
    });

    it("disconnects relay on stop if connected", async () => {
      await agoraService.connectRelay("ws://test");
      expect(agoraService.isRelayConnected()).toBe(true);

      await provider.start();
      await provider.stop();

      expect(agoraService.isRelayConnected()).toBe(false);
    });

    it("is not ready when service is null", async () => {
      const providerNoService = new AgoraProvider(
        null,
        appendWriter,
        agoraInboxManager,
        eventSink,
        clock
      );
      await providerNoService.start();
      expect(await providerNoService.isReady()).toBe(false);
    });
  });

  describe("send - outbound messages", () => {
    beforeEach(async () => {
      await provider.start();
    });

    it("sends agora.send message to peer", async () => {
      const message = createMessage({
        type: "agora.send",
        payload: {
          peerName: "test-peer",
          type: "greeting",
          payload: { text: "Hello!" },
        },
      });

      await provider.send(message);

      expect(agoraService.sentMessages).toHaveLength(1);
      expect(agoraService.sentMessages[0]).toEqual({
        peerName: "test-peer",
        type: "greeting",
        payload: { text: "Hello!" },
        inReplyTo: undefined,
      });
    });

    it("sends agora.send message with inReplyTo", async () => {
      const message = createMessage({
        type: "agora.send",
        payload: {
          peerName: "test-peer",
          type: "response",
          payload: { status: "ok" },
          inReplyTo: "envelope-123",
        },
      });

      await provider.send(message);

      expect(agoraService.sentMessages[0].inReplyTo).toBe("envelope-123");
    });

    it("ignores non-agora.send messages", async () => {
      const message = createMessage({
        type: "other.message",
        payload: { data: "test" },
      });

      await provider.send(message);

      expect(agoraService.sentMessages).toHaveLength(0);
    });

    it("throws error when not started", async () => {
      await provider.stop();

      const message = createMessage({
        type: "agora.send",
        payload: { peerName: "test", type: "test", payload: {} },
      });

      await expect(provider.send(message)).rejects.toThrow("Provider agora not started");
    });

    it("throws error when service is null", async () => {
      const providerNoService = new AgoraProvider(
        null,
        appendWriter,
        agoraInboxManager,
        eventSink,
        clock
      );
      await providerNoService.start();

      const message = createMessage({
        type: "agora.send",
        payload: { peerName: "test", type: "test", payload: {} },
      });

      await expect(providerNoService.send(message)).rejects.toThrow("Agora service not configured");
    });

    it("throws error for invalid payload", async () => {
      const message = createMessage({
        type: "agora.send",
        payload: { invalid: "payload" }, // Missing peerName and type
      });

      await expect(provider.send(message)).rejects.toThrow(
        "Invalid agora.send payload: missing peerName or type"
      );
    });

    it("throws error when send fails", async () => {
      agoraService.shouldFailSend = true;

      const message = createMessage({
        type: "agora.send",
        payload: { peerName: "test", type: "test", payload: {} },
      });

      await expect(provider.send(message)).rejects.toThrow("Failed to send Agora message: Mock error");
    });
  });

  describe("processEnvelope - inbound messages", () => {
    const testEnvelope: Envelope = {
      id: "env-123",
      type: "greeting",
      sender: "ed25519:ABCDEF1234567890",
      timestamp: Date.now(),
      payload: { text: "Hello from peer" },
      signature: "sig-abc",
    };

    beforeEach(async () => {
      await provider.start();
      // Initialize substrate files
      await fs.writeFile("/test/substrate/PROGRESS.md", "# Progress\n");
      await fs.writeFile("/test/substrate/AGORA_INBOX.md", "# Agora Inbox\n## Unread\n## Read\n");
    });

    it("processes webhook envelope through full pipeline", async () => {
      await provider.processEnvelope(testEnvelope, "webhook");

      // 1. Verify PROGRESS.md logging
      const progress = await fs.readFile("/test/substrate/PROGRESS.md");
      expect(progress).toContain("[AGORA] Received greeting from ...34567890");
      expect(progress).toContain('payload: {"text":"Hello from peer"}');

      // 2. Verify AGORA_INBOX.md persistence
      const inbox = await fs.readFile("/test/substrate/AGORA_INBOX.md");
      expect(inbox).toContain("env-123");
      expect(inbox).toContain("...34567890"); // shortKey format

      // 3. Verify WebSocket event emission
      expect(eventSink.events).toHaveLength(1);
      expect(eventSink.events[0]).toMatchObject({
        type: "agora_message",
        timestamp: "2026-02-16T18:00:00.000Z",
        data: {
          envelopeId: "env-123",
          messageType: "greeting",
          sender: "ed25519:ABCDEF1234567890",
          payload: { text: "Hello from peer" },
          source: "webhook",
        },
      });

      // 4. Verify TinyBus message routing
      expect(messageHandler).toHaveBeenCalledTimes(1);
      const routedMessage = messageHandler.mock.calls[0][0];
      expect(routedMessage.type).toBe("agora.peer.message");
      expect(routedMessage.source).toBe("agora");
      expect(routedMessage.destination).toBe("session-injection");
      expect(routedMessage.payload).toMatchObject({
        sender: "ed25519:ABCDEF1234567890",
        senderShort: "...34567890",
        envelopeId: "env-123",
        messageType: "greeting",
        payload: { text: "Hello from peer" },
        timestamp: "2026-02-16T18:00:00.000Z",
      });
    });

    it("processes relay envelope with correct type", async () => {
      await provider.processEnvelope(testEnvelope, "relay");

      // Verify PROGRESS.md uses AGORA-RELAY label
      const progress = await fs.readFile("/test/substrate/PROGRESS.md");
      expect(progress).toContain("[AGORA-RELAY] Received greeting");

      // Verify WebSocket event source
      expect(eventSink.events[0].data).toMatchObject({ source: "relay" });

      // Verify TinyBus message type
      const routedMessage = messageHandler.mock.calls[0][0];
      expect(routedMessage.type).toBe("agora.relay.message");
    });

    it("truncates long payloads in PROGRESS.md", async () => {
      const longPayload = { text: "x".repeat(300) };
      const longEnvelope = { ...testEnvelope, payload: longPayload };

      await provider.processEnvelope(longEnvelope);

      const progress = await fs.readFile("/test/substrate/PROGRESS.md");
      expect(progress).toContain("...");
      expect(progress.length).toBeLessThan(500); // Truncated
    });

    it("handles envelope without event sink", async () => {
      const providerNoSink = new AgoraProvider(
        agoraService,
        appendWriter,
        agoraInboxManager,
        null,
        clock
      );
      providerNoSink.onMessage(messageHandler);
      await providerNoSink.start();

      await expect(providerNoSink.processEnvelope(testEnvelope)).resolves.not.toThrow();
      expect(messageHandler).toHaveBeenCalledTimes(1);
    });

    it("handles envelope without message handler", async () => {
      const providerNoHandler = new AgoraProvider(
        agoraService,
        appendWriter,
        agoraInboxManager,
        eventSink,
        clock
      );
      await providerNoHandler.start();

      await expect(providerNoHandler.processEnvelope(testEnvelope)).resolves.not.toThrow();
      // Should still log, persist, and emit event
      expect(eventSink.events).toHaveLength(1);
    });
  });

  describe("onMessage", () => {
    it("registers message handler", () => {
      const handler = jest.fn();
      provider.onMessage(handler);
      // Handler is private, but we can verify it's called in processEnvelope tests
      expect(provider).toBeDefined();
    });
  });
});
