import { AgoraService, type AgoraConfig, type PeerConfig } from "../../src/agora/AgoraService";

// Mock @rookdaemon/agora so RelayClient is a constructor returning a mock (no real WebSocket)
jest.mock("@rookdaemon/agora", () => ({
  sendToPeer: jest.fn(),
  decodeInboundEnvelope: jest.fn().mockReturnValue({ ok: false, reason: "not_agora_message" }),
  RelayClient: jest.fn().mockImplementation(() => ({
    connect: jest.fn().mockResolvedValue(undefined),
    disconnect: jest.fn(),
    connected: jest.fn().mockReturnValue(false),
    on: jest.fn(),
  })),
}));

describe("AgoraService", () => {
  let service: AgoraService;
  let testConfig: AgoraConfig;
  let testPeer: PeerConfig;

  beforeEach(() => {
    // Test identity (fake keys)
    testConfig = {
      identity: {
        publicKey: "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        privateKey: "302e020100300506032b6570042204bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      peers: new Map(),
    };

    // Test peer
    testPeer = {
      publicKey: "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      url: "http://localhost:18790/hooks",
      token: "test-token-123",
    };

    testConfig.peers.set("testpeer", testPeer);

    service = new AgoraService(testConfig);
  });

  describe("getPeers", () => {
    it("should return list of configured peer names", () => {
      const peers = service.getPeers();
      expect(peers).toEqual(["testpeer"]);
    });

    it("should return empty array when no peers configured", () => {
      const emptyService = new AgoraService({
        identity: testConfig.identity,
        peers: new Map(),
      });
      expect(emptyService.getPeers()).toEqual([]);
    });
  });

  describe("getPeerConfig", () => {
    it("should return peer configuration by name", () => {
      const config = service.getPeerConfig("testpeer");
      expect(config).toEqual(testPeer);
    });

    it("should return undefined for unknown peer", () => {
      const config = service.getPeerConfig("unknown");
      expect(config).toBeUndefined();
    });
  });

  describe("sendMessage", () => {
    it("should return error for unknown peer", async () => {
      const result = await service.sendMessage({
        peerName: "unknown",
        type: "announce",
        payload: { test: true },
      });

      expect(result.ok).toBe(false);
      expect(result.error).toContain("Unknown peer");
    });
  });

  describe("decodeInbound", () => {
    it("should reject malformed envelope", async () => {
      const result = await service.decodeInbound("not-an-envelope");

      expect(result.ok).toBe(false);
      expect(result.reason).toBeDefined();
    });
  });

  describe("relay methods", () => {
    it("should have connectRelay method", () => {
      expect(service.connectRelay).toBeDefined();
      expect(typeof service.connectRelay).toBe("function");
    });

    it("should have setRelayMessageHandler method", () => {
      expect(service.setRelayMessageHandler).toBeDefined();
      expect(typeof service.setRelayMessageHandler).toBe("function");
    });

    it("should have disconnectRelay method", () => {
      expect(service.disconnectRelay).toBeDefined();
      expect(typeof service.disconnectRelay).toBe("function");
    });

    it("should have isRelayConnected method", () => {
      expect(service.isRelayConnected).toBeDefined();
      expect(typeof service.isRelayConnected).toBe("function");
    });

    it("should return false for isRelayConnected when not connected", () => {
      expect(service.isRelayConnected()).toBe(false);
    });
  });

  describe("loadConfig", () => {
    it("should be a static method", () => {
      expect(AgoraService.loadConfig).toBeDefined();
      expect(typeof AgoraService.loadConfig).toBe("function");
    });
  });
});
