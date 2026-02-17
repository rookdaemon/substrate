import { AgoraOutboundProvider } from "../../src/agora/AgoraOutboundProvider";
import { IAgoraService } from "../../src/agora/IAgoraService";
import { createMessage } from "../../src/tinybus/core/Message";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

class MockAgoraService implements IAgoraService {
  public sentMessages: Array<{ peerName: string; type: string; payload: unknown; inReplyTo?: string }> = [];
  public shouldFailSend = false;

  async sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }) {
    if (this.shouldFailSend) {
      return { ok: false, status: 500, error: "Mock error" };
    }
    this.sentMessages.push(options);
    return { ok: true, status: 200 };
  }

  async decodeInbound(_message: string) {
    return { ok: false, reason: "not implemented" };
  }

  getPeers() {
    return ["test-peer"];
  }

  getPeerConfig(_name: string) {
    return undefined;
  }

  async connectRelay(_url: string) {}

  async disconnectRelay() {}

  setRelayMessageHandler(_handler: (envelope: Envelope) => void) {}

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
          peerName: "test-peer",
          type: "request",
          payload: { question: "Hello?" },
        },
      });

      await provider.send(message);

      expect(agoraService.sentMessages).toHaveLength(1);
      expect(agoraService.sentMessages[0]).toEqual({
        peerName: "test-peer",
        type: "request",
        payload: { question: "Hello?" },
      });
    });

    it("should handle agora.send with inReplyTo", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          peerName: "test-peer",
          type: "response",
          payload: { answer: "Yes" },
          inReplyTo: "envelope-123",
        },
      });

      await provider.send(message);

      expect(agoraService.sentMessages[0].inReplyTo).toBe("envelope-123");
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
          peerName: "test-peer",
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
          peerName: "test-peer",
          type: "request",
          payload: {},
        },
      });

      await expect(providerNoService.send(message)).rejects.toThrow("Agora service not configured");
    });

    it("should throw error for invalid payload", async () => {
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          // Missing peerName
          type: "request",
          payload: {},
        },
      });

      await expect(provider.send(message)).rejects.toThrow("Invalid agora.send payload: missing peerName or type");
    });

    it("should throw error if send fails", async () => {
      agoraService.shouldFailSend = true;
      await provider.start();

      const message = createMessage({
        type: "agora.send",
        payload: {
          peerName: "test-peer",
          type: "request",
          payload: {},
        },
      });

      await expect(provider.send(message)).rejects.toThrow("Failed to send Agora message: Mock error");
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
