import { AgoraOutboundProvider } from "../../src/agora/AgoraOutboundProvider";
import { IAgoraService } from "../../src/agora/IAgoraService";
import { createMessage } from "../../src/tinybus/core/Message";

class MockAgoraService implements IAgoraService {
  public sentMessages: Array<{ peerName: string; type: string; payload: unknown; inReplyTo?: string; allRecipients?: string[] }> = [];
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
    return this.peerConfigs[name];
  }

  async connectRelay(_url: string) {}

  async disconnectRelay() {}

  isRelayConnected() {
    return false;
  }
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

      expect(agoraService.sentMessages).toHaveLength(1);
      expect(agoraService.sentMessages[0]).toMatchObject({
        peerName: "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
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

      expect(agoraService.sentMessages[0].inReplyTo).toBe("envelope-123");
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

      expect(agoraService.sentMessages).toHaveLength(1);
      expect(agoraService.sentMessages[0].peerName).toBe("302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa");
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

      expect(agoraService.sentMessages).toHaveLength(2);
      const expectedAllRecipients = [
        "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        "302a300506032b6570032100bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      ];
      for (const msg of agoraService.sentMessages) {
        expect(msg.payload).toEqual({ text: "Hello both" });
        expect(msg.type).toBe("publish");
        expect(msg.allRecipients).toEqual(expectedAllRecipients);
      }
    });

    it("should not throw on partial multi-recipient failure", async () => {
      let callCount = 0;
      agoraService.sendMessage = async (options) => {
        callCount++;
        if (callCount === 2) return { ok: false, status: 500, error: "one failed" };
        agoraService.sentMessages.push(options);
        return { ok: true, status: 200 };
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
      expect(agoraService.sentMessages).toHaveLength(2);
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
});
