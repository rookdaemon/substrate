import { AgoraOutboundProvider } from "../../src/agora/AgoraOutboundProvider";
import { IAgoraService } from "../../src/agora/IAgoraService";
import { createMessage } from "../../src/tinybus/core/Message";
import { IConversationManager } from "../../src/conversation/IConversationManager";
import { AgentRole } from "../../src/agents/types";
import { IClock } from "../../src/substrate/abstractions/IClock";

class MockAgoraService implements IAgoraService {
  public sentMessages: Array<{ peerName: string; type: string; payload: unknown; inReplyTo?: string; allRecipients?: string[] }> = [];
  public sentToAll: Array<{ recipients: string[]; type: string; payload: unknown; inReplyTo?: string }> = [];
  public repliedEnvelopes: Array<{ targetPubkey: string; type: string; payload: unknown; inReplyTo: string }> = [];
  public shouldFailSend = false;
  public shouldFailReply = false;

  async sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string; allRecipients?: string[] }) {
    if (this.shouldFailSend) {
      return { ok: false, status: 500, error: "Mock error" };
    }
    this.sentMessages.push(options);
    return { ok: true, status: 200 };
  }

  async sendToAll(options: { recipients: string[]; type: string; payload: unknown; inReplyTo?: string }) {
    this.sentToAll.push(options);
    if (this.shouldFailSend) {
      return { ok: false, errors: options.recipients.map(r => ({ recipient: r, error: "Mock error" })) };
    }
    return { ok: true, errors: [] };
  }

  async replyToEnvelope(options: { targetPubkey: string; type: string; payload: unknown; inReplyTo: string }) {
    if (this.shouldFailReply) {
      return { ok: false, status: 0, error: "Mock reply error" };
    }
    this.repliedEnvelopes.push(options);
    return { ok: true, status: 0 };
  }

  async decodeInbound(_message: string) {
    return { ok: false, reason: "not implemented" };
  }

  public peers: string[] = ["test-peer", "other-peer", "third-peer"];
  private peerConfigs: Record<string, { publicKey: string; name?: string }> = {
    "test-peer": {
      publicKey: "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      name: "test-peer",
    },
    "other-peer": {
      publicKey: "302a300506032b6570032100bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      name: "other-peer",
    },
    "third-peer": {
      publicKey: "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      name: "third-peer",
    },
  };

  getPeers() {
    return this.peers;
  }

  getPeerConfig(name: string) {
    const direct = this.peerConfigs[name];
    if (direct) {
      return direct;
    }
    return Object.values(this.peerConfigs).find(
      (peer) => peer.publicKey === name || peer.name === name
    );
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

class MockConversationManager implements IConversationManager {
  public appendedEntries: Array<{ role: AgentRole; entry: string }> = [];
  public shouldThrow = false;

  async append(role: AgentRole, entry: string): Promise<void> {
    if (this.shouldThrow) throw new Error("Mock conversation error");
    this.appendedEntries.push({ role, entry });
  }
}

class MockClock implements IClock {
  constructor(private readonly time: Date = new Date("2026-03-10T11:17:03.381Z")) {}
  now(): Date { return this.time; }
}

describe("AgoraOutboundProvider", () => {
  let provider: AgoraOutboundProvider;
  let agoraService: MockAgoraService;

  beforeEach(() => {
    agoraService = new MockAgoraService();
    provider = new AgoraOutboundProvider(agoraService);
  });

  describe("send", () => {
    it("should handle agora.send messages", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer"],
          type: "request",
          payload: { question: "Hello?" },
        },
      });

      await provider.send(message);

      expect(agoraService.sentToAll).toHaveLength(1);
      expect(agoraService.sentToAll[0]).toMatchObject({
        recipients: ["302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"],
        type: "request",
        payload: { question: "Hello?" },
      });
    });

    it("should handle agora.send with inReplyTo", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer"],
          type: "response",
          payload: { answer: "Yes" },
          inReplyTo: "envelope-123",
        },
      });

      await provider.send(message);

      expect(agoraService.sentToAll[0].inReplyTo).toBe("envelope-123");
    });

    it("should expand short peer refs before send", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["...aaaaaaaa"],
          type: "publish",
          payload: { text: "hello" },
        },
      });

      await provider.send(message);

      expect(agoraService.sentToAll).toHaveLength(1);
      expect(agoraService.sentToAll[0].recipients).toEqual(["302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"]);
    });

    it("should send to multiple recipients", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer", "other-peer"],
          type: "publish",
          payload: { text: "Hello both" },
        },
      });

      await provider.send(message);

      expect(agoraService.sentToAll).toHaveLength(1);
      expect(agoraService.sentToAll[0]).toMatchObject({
        recipients: [
          "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
          "302a300506032b6570032100bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
        ],
        type: "publish",
        payload: { text: "Hello both" },
      });
    });

    it("should not throw on partial multi-recipient failure", async () => {
      agoraService.sendToAll = async (options) => {
        agoraService.sentToAll.push(options);
        return {
          ok: true, // at least one succeeded
          errors: [{ recipient: options.recipients[1], error: "one failed" }],
        };
      };
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer", "other-peer", "third-peer"],
          type: "publish",
          payload: { text: "Partial" },
        },
      });

      // Should not throw — only 1 of 3 failed
      await provider.send(message);
      expect(agoraService.sentToAll).toHaveLength(1);
    });

    it("should throw when all sends fail", async () => {
      agoraService.shouldFailSend = true;
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer"],
          type: "request",
          payload: {},
        },
      });

      await expect(provider.send(message)).rejects.toThrow("All sends failed");
    });

    it("should throw when no recipients provided", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          type: "publish",
          payload: { text: "no recipients" },
        },
      });

      await expect(provider.send(message)).rejects.toThrow("no recipients");
    });

    it("should ignore non-agora.send messages", async () => {
      await provider.start();

      const message = createMessage({
        type: "other.message",
        payload: { data: "test" },
      });

      await provider.send(message);

      expect(agoraService.sentMessages).toHaveLength(0);
    });

    it("should throw error if not started", async () => {
      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer"],
          type: "request",
          payload: {},
        },
      });

      await expect(provider.send(message)).rejects.toThrow("Provider agora not started");
    });

    it("should throw error if agora service not configured", async () => {
      const providerNoService = new AgoraOutboundProvider(null);
      await providerNoService.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer"],
          type: "request",
          payload: {},
        },
      });

      await expect(providerNoService.send(message)).rejects.toThrow("Agora service not configured");
    });

    it("should throw error for missing type", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer"],
          payload: {},
        },
      });

      await expect(provider.send(message)).rejects.toThrow("Invalid agora.send payload: missing type");
    });

    it("should route targetPubkey to replyToEnvelope", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          targetPubkey: "302a300506032b6570032100deadbeef",
          type: "publish",
          payload: { text: "hello stranger" },
          inReplyTo: "envelope-abc-123",
        },
      });

      await provider.send(message);

      expect(agoraService.repliedEnvelopes).toHaveLength(1);
      expect(agoraService.repliedEnvelopes[0]).toEqual({
        targetPubkey: "302a300506032b6570032100deadbeef",
        type: "publish",
        payload: { text: "hello stranger" },
        inReplyTo: "envelope-abc-123",
      });
      // Should NOT have used sendMessage
      expect(agoraService.sentMessages).toHaveLength(0);
    });

    it("should route unknown full-key recipients with inReplyTo to replyToEnvelope", async () => {
      await provider.start();

      const unknownPubkey = "302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
      const message = createMessage({
        type: "agora.send",
        payload: {
          to: [unknownPubkey],
          type: "publish",
          payload: { text: "reply to unknown" },
          inReplyTo: "env-unknown-1",
        },
      });

      await provider.send(message);

      expect(agoraService.repliedEnvelopes).toHaveLength(1);
      expect(agoraService.repliedEnvelopes[0]).toEqual({
        targetPubkey: unknownPubkey,
        type: "publish",
        payload: { text: "reply to unknown" },
        inReplyTo: "env-unknown-1",
      });
      expect(agoraService.sentToAll).toHaveLength(0);
    });

    it("should split configured and unknown recipients for inReplyTo sends", async () => {
      await provider.start();

      const unknownPubkey = "302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd";
      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer", unknownPubkey],
          type: "publish",
          payload: { text: "mixed" },
          inReplyTo: "env-mixed-1",
        },
      });

      await provider.send(message);

      expect(agoraService.sentToAll).toHaveLength(1);
      expect(agoraService.sentToAll[0].recipients).toEqual([
        "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      ]);
      expect(agoraService.repliedEnvelopes).toHaveLength(1);
      expect(agoraService.repliedEnvelopes[0].targetPubkey).toBe(unknownPubkey);
    });

    it("should expand short targetPubkey refs before reply", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          targetPubkey: "...bbbbbbbb",
          type: "publish",
          payload: { text: "reply" },
          inReplyTo: "env-short-target",
        },
      });

      await provider.send(message);

      expect(agoraService.repliedEnvelopes).toHaveLength(1);
      expect(agoraService.repliedEnvelopes[0].targetPubkey).toBe("302a300506032b6570032100bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb");
    });

    it("should reject targetPubkey without inReplyTo", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          targetPubkey: "302a300506032b6570032100deadbeef",
          type: "publish",
          payload: { text: "no reply ref" },
        },
      });

      await expect(provider.send(message)).rejects.toThrow("targetPubkey requires inReplyTo");
    });

    it("should throw when reply to pubkey fails", async () => {
      agoraService.shouldFailReply = true;
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          targetPubkey: "302a300506032b6570032100deadbeef",
          type: "publish",
          payload: { text: "will fail" },
          inReplyTo: "envelope-fail",
        },
      });

      await expect(provider.send(message)).rejects.toThrow("Reply to pubkey failed");
    });

    it("should prefer targetPubkey over to when both present", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          to: ["test-peer"],
          targetPubkey: "302a300506032b6570032100deadbeef",
          type: "publish",
          payload: { text: "both set" },
          inReplyTo: "envelope-both",
        },
      });

      await provider.send(message);

      // Should use replyToEnvelope, not sendMessage
      expect(agoraService.repliedEnvelopes).toHaveLength(1);
      expect(agoraService.sentMessages).toHaveLength(0);
    });
  });

  describe("lifecycle", () => {
    it("should start and stop correctly", async () => {
      expect(await provider.isReady()).toBe(false);

      await provider.start();
      expect(await provider.isReady()).toBe(true);

      await provider.stop();
      expect(await provider.isReady()).toBe(false);
    });

    it("should disconnect relay on stop if connected", async () => {
      agoraService.isRelayConnected = () => true;
      const disconnectSpy = jest.spyOn(agoraService, "disconnectRelay");

      await provider.start();
      await provider.stop();

      expect(disconnectSpy).toHaveBeenCalled();
    });
  });

  describe("getMessageTypes", () => {
    it("should return agora.send", () => {
      expect(provider.getMessageTypes()).toEqual(["agora.send"]);
    });
  });

  describe("conversation logging (AGORA_OUT)", () => {
    let conversationManager: MockConversationManager;
    let clock: MockClock;

    beforeEach(() => {
      conversationManager = new MockConversationManager();
      clock = new MockClock();
    });

    it("should write [AGORA_OUT] entry to CONVERSATION.md after successful send via to list", async () => {
      const p = new AgoraOutboundProvider(agoraService, undefined, undefined, undefined, conversationManager, clock);
      await p.start();

      await p.send(createMessage({
        type: "agora.send",
        payload: { to: ["test-peer"], type: "request", payload: { text: "Hello?" } },
      }));

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const { role, entry } = conversationManager.appendedEntries[0];
      expect(role).toBe(AgentRole.SUBCONSCIOUS);
      expect(entry).toContain("[AGORA_OUT 2026-03-10T11:17:03.381Z]");
      expect(entry).toContain("TO: test-peer");
      expect(entry).toContain("request:");
      expect(entry).toContain("Hello?");
    });

    it("should write [AGORA_OUT] entry after successful targetPubkey reply", async () => {
      const p = new AgoraOutboundProvider(agoraService, undefined, undefined, undefined, conversationManager, clock);
      await p.start();

      await p.send(createMessage({
        type: "agora.send",
        payload: {
          targetPubkey: "302a300506032b6570032100deadbeef",
          type: "publish",
          payload: { text: "reply text" },
          inReplyTo: "env-abc",
        },
      }));

      expect(conversationManager.appendedEntries).toHaveLength(1);
      const { role, entry } = conversationManager.appendedEntries[0];
      expect(role).toBe(AgentRole.SUBCONSCIOUS);
      expect(entry).toContain("[AGORA_OUT");
      expect(entry).toContain("TO: 302a300506032b6570032100deadbeef");
      expect(entry).toContain("publish:");
      expect(entry).toContain("reply text");
    });

    it("should NOT log when all sends fail", async () => {
      agoraService.shouldFailSend = true;
      const p = new AgoraOutboundProvider(agoraService, undefined, undefined, undefined, conversationManager, clock);
      await p.start();

      await expect(p.send(createMessage({
        type: "agora.send",
        payload: { to: ["test-peer"], type: "request", payload: {} },
      }))).rejects.toThrow("All sends failed");

      expect(conversationManager.appendedEntries).toHaveLength(0);
    });

    it("should not throw when conversation logging fails (best-effort)", async () => {
      conversationManager.shouldThrow = true;
      const p = new AgoraOutboundProvider(agoraService, undefined, undefined, undefined, conversationManager, clock);
      await p.start();

      // Send should succeed even though logging throws
      await expect(p.send(createMessage({
        type: "agora.send",
        payload: { to: ["test-peer"], type: "request", payload: { text: "hi" } },
      }))).resolves.toBeUndefined();

      expect(agoraService.sentToAll).toHaveLength(1);
    });

    it("should work without conversationManager (no-op logging)", async () => {
      const p = new AgoraOutboundProvider(agoraService);
      await p.start();

      await p.send(createMessage({
        type: "agora.send",
        payload: { to: ["test-peer"], type: "request", payload: { text: "hi" } },
      }));

      expect(agoraService.sentToAll).toHaveLength(1);
    });
  });
});
