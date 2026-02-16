import { AgoraService } from "../../src/agora/AgoraService";
import { EventEmitter } from "events";

// Mock @rookdaemon/agora so dynamic imports in AgoraService don't load the real package
// (which can register timers/handles and prevent Jest from exiting)
jest.mock("@rookdaemon/agora", () => ({
  sendToPeer: jest.fn().mockResolvedValue({ ok: true, status: 200 }),
  decodeInboundEnvelope: jest.fn().mockReturnValue({ ok: false, reason: "not_agora_message" }),
  RelayClient: jest.fn(),
}));

/** Fake RelayClient backed by EventEmitter so we can simulate errors */
class FakeRelayClient extends EventEmitter {
  connectResult: "ok" | Error = "ok";
  _connected = false;
  connect = jest.fn(async () => {
    if (this.connectResult instanceof Error) {
      throw this.connectResult;
    }
    this._connected = true;
  });
  disconnect = jest.fn(() => { this._connected = false; });
  connected = jest.fn(() => this._connected);
}

function createFakeFactory() {
  const state = { client: null as FakeRelayClient | null };
  const factory = jest.fn(() => {
    state.client = new FakeRelayClient();
    return state.client;
  });
  return { factory, state };
}

describe("AgoraService", () => {
  let service: AgoraService;
  let testConfig: {
    identity: { publicKey: string; privateKey: string; name?: string };
    peers: Map<string, { publicKey: string; url: string; token: string }>;
    relay?: { url: string; autoConnect: boolean; name?: string };
  };

  beforeEach(() => {
    testConfig = {
      identity: {
        publicKey: "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        privateKey: "302e020100300506032b6570042204bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
      },
      peers: new Map(),
    };

    testConfig.peers.set("testpeer", {
      publicKey: "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      url: "http://localhost:18790/hooks",
      token: "test-token-123",
    });

    service = new AgoraService(testConfig);
  });

  afterEach(async () => {
    if (service?.isRelayConnected()) {
      await service.disconnectRelay();
    }
  });

  describe("getPeers", () => {
    it("should return list of configured peer names", () => {
      expect(service.getPeers()).toEqual(["testpeer"]);
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
      expect(service.getPeerConfig("testpeer")).toEqual(testConfig.peers.get("testpeer"));
    });

    it("should return undefined for unknown peer", () => {
      expect(service.getPeerConfig("unknown")).toBeUndefined();
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

  describe("connectRelay", () => {
    let logger: { messages: string[]; debug: (msg: string) => void };

    beforeEach(() => {
      logger = { messages: [], debug(msg: string) { this.messages.push(msg); } };
      testConfig.relay = { url: "wss://relay.test", autoConnect: true };
    });

    it("should connect successfully and report connected", async () => {
      const { factory, state } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");

      expect(factory).toHaveBeenCalled();
      expect(state.client!.connect).toHaveBeenCalled();
      expect(service.isRelayConnected()).toBe(true);
    });

    it("should not crash when connect() throws — logs the error", async () => {
      const fake = createFakeFactory();
      (fake.factory as jest.Mock).mockImplementation(() => {
        const client = new FakeRelayClient();
        client.connectResult = new Error("Unexpected server response: 502");
        return client;
      });
      service = new AgoraService(testConfig, logger, fake.factory);

      // Must not throw
      await service.connectRelay("wss://relay.test");

      expect(service.isRelayConnected()).toBe(false);
      expect(logger.messages.some(m => m.includes("502"))).toBe(true);
    });

    it("should log async relay errors emitted after connect", async () => {
      const { factory, state } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");

      // Simulate an error event emitted later (e.g. connection drop)
      state.client!.emit("error", new Error("Connection reset"));

      expect(logger.messages.some(m => m.includes("Connection reset"))).toBe(true);
    });

    it("should be a no-op when already connected", async () => {
      const { factory } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");
      await service.connectRelay("wss://relay.test");

      // Factory called only once
      expect(factory).toHaveBeenCalledTimes(1);
    });

    it("should disconnect and allow reconnect", async () => {
      const { factory } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");
      expect(service.isRelayConnected()).toBe(true);

      await service.disconnectRelay();
      expect(service.isRelayConnected()).toBe(false);

      // Can reconnect after disconnect
      await service.connectRelay("wss://relay.test");
      expect(service.isRelayConnected()).toBe(true);
      expect(factory).toHaveBeenCalledTimes(2);
    });

    it("should return false for isRelayConnected when not connected", () => {
      expect(service.isRelayConnected()).toBe(false);
    });

    it("should use identity.name when provided", async () => {
      testConfig.identity.name = "alice";
      const { factory } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "alice",
        })
      );
    });

    it("should fall back to relay.name when identity.name not provided", async () => {
      testConfig.relay!.name = "bob";
      const { factory } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "bob",
        })
      );
    });

    it("should prioritize identity.name over relay.name", async () => {
      testConfig.identity.name = "alice";
      testConfig.relay!.name = "bob";
      const { factory } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          name: "alice",
        })
      );
    });

    it("should omit name when neither identity.name nor relay.name provided", async () => {
      const { factory } = createFakeFactory();
      service = new AgoraService(testConfig, logger, factory);

      await service.connectRelay("wss://relay.test");

      expect(factory).toHaveBeenCalledWith(
        expect.objectContaining({
          name: undefined,
        })
      );
    });
  });

  describe("loadConfig", () => {
    it("should be a static method", () => {
      expect(AgoraService.loadConfig).toBeDefined();
      expect(typeof AgoraService.loadConfig).toBe("function");
    });
  });
});
