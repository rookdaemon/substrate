import { AgoraService, type AgoraConfig, type PeerConfig } from "../../src/agora/AgoraService";

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

  describe("loadConfig", () => {
    it("should be a static method", () => {
      expect(AgoraService.loadConfig).toBeDefined();
      expect(typeof AgoraService.loadConfig).toBe("function");
    });
  });
});
