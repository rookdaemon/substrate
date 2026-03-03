import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAgoraTools, IgnoredPeersManager } from "../../src/agora/AgoraMcpTools";
import { TinyBus } from "../../src/tinybus/core/TinyBus";
import { MemoryProvider } from "../../src/tinybus/providers/MemoryProvider";
import type { IAgoraService } from "../../src/agora/IAgoraService";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

class MockAgoraService implements IAgoraService {
  public sentMessages: Array<{ peerName: string; type: string; payload: unknown; inReplyTo?: string }> = [];
  public repliedEnvelopes: Array<{ targetPubkey: string; type: string; payload: unknown; inReplyTo: string }> = [];
  public peers: string[] = ["rook", "bishop", "stefan"];

  async sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }) {
    this.sentMessages.push(options);
    return { ok: true, status: 200 };
  }

  async replyToEnvelope(options: { targetPubkey: string; type: string; payload: unknown; inReplyTo: string }) {
    this.repliedEnvelopes.push(options);
    return { ok: true, status: 200 };
  }

  async decodeInbound(_message: string) { return { ok: false, reason: "not implemented" }; }
  getPeers() { return this.peers; }
  getPeerConfig(_name: string) { return undefined; }
  async connectRelay(_url: string) {}
  async disconnectRelay() {}
  setRelayMessageHandler(_handler: (envelope: Envelope) => void) {}
  setRelayMessageHandlerWithName(_handler: (envelope: Envelope, from: string, fromName?: string) => void) {}
  isRelayConnected() { return false; }
}

function makeIgnoredPeersManager(initial: string[] = []): IgnoredPeersManager {
  const peers = new Set(initial);
  return {
    ignorePeer: jest.fn((pk: string) => { const before = peers.size; peers.add(pk); return peers.size > before; }),
    unignorePeer: jest.fn((pk: string) => peers.delete(pk)),
    listIgnoredPeers: jest.fn(() => Array.from(peers).sort()),
  };
}

async function buildClient(
  agoraService: IAgoraService,
  ignoredPeersManager?: IgnoredPeersManager | null,
): Promise<{ client: Client; bus: TinyBus; agora: MockAgoraService; cleanup: () => Promise<void> }> {
  const bus = new TinyBus();
  bus.registerProvider(new MemoryProvider("agora-out", ["agora.send"]));
  await bus.start();

  const server = new McpServer({ name: "test", version: "1.0.0" });
  registerAgoraTools(server, { tinyBus: bus, agoraService, ignoredPeersManager });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);

  return {
    client,
    bus,
    agora: agoraService as MockAgoraService,
    cleanup: async () => { await client.close(); await bus.stop(); },
  };
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  return JSON.parse(result.content.find((c) => c.type === "text")?.text ?? "{}");
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("AgoraMcpTools", () => {
  let agora: MockAgoraService;
  let client: Client;
  let bus: TinyBus;
  let cleanup: () => Promise<void>;

  beforeEach(() => {
    agora = new MockAgoraService();
  });

  afterEach(async () => {
    await cleanup?.();
  });

  // -------------------------------------------------------------------------
  // send_agora_message
  // -------------------------------------------------------------------------
  describe("send_agora_message", () => {
    beforeEach(async () => {
      ({ client, bus, cleanup } = await buildClient(agora));
    });

    it("is registered", async () => {
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name)).toContain("send_agora_message");
    });

    it("returns success with messageId", async () => {
      const result = await client.callTool({
        name: "send_agora_message",
        arguments: { peerName: "stefan", text: "hello" },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(typeof data.messageId).toBe("string");
    });

    it("publishes agora.send message to TinyBus with correct shape", async () => {
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_agora_message",
        arguments: { peerName: "stefan", text: "hello stefan", inReplyTo: "env-123" },
      });
      const sent = provider.getSentMessages();
      expect(sent).toHaveLength(1);
      expect(sent[0].type).toBe("agora.send");
      const payload = sent[0].payload as Record<string, unknown>;
      expect(payload.peerName).toBe("stefan");
      expect(payload.type).toBe("publish");
      expect(payload.inReplyTo).toBe("env-123");
      expect((payload.payload as Record<string, unknown>).text).toBe("hello stefan");
    });

    it("omits peerName from payload when not provided (broadcast)", async () => {
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_agora_message",
        arguments: { text: "broadcast message" },
      });
      const payload = provider.getSentMessages()[0].payload as Record<string, unknown>;
      expect(payload.peerName).toBeUndefined();
    });

    it("includes targetPubkey when provided", async () => {
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_agora_message",
        arguments: { targetPubkey: "deadbeef", text: "hi stranger", inReplyTo: "env-456" },
      });
      const payload = provider.getSentMessages()[0].payload as Record<string, unknown>;
      expect(payload.targetPubkey).toBe("deadbeef");
      expect(payload.inReplyTo).toBe("env-456");
    });

    it("omits inReplyTo from payload when not provided", async () => {
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_agora_message",
        arguments: { peerName: "rook", text: "unsolicited" },
      });
      const payload = provider.getSentMessages()[0].payload as Record<string, unknown>;
      expect(payload.inReplyTo).toBeUndefined();
    });
  });

  // -------------------------------------------------------------------------
  // list_peers
  // -------------------------------------------------------------------------
  describe("list_peers", () => {
    beforeEach(async () => {
      ({ client, cleanup } = await buildClient(agora));
    });

    it("returns configured peer names", async () => {
      const result = await client.callTool({ name: "list_peers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { peers: string[] };
      expect(data.peers).toEqual(["rook", "bishop", "stefan"]);
    });
  });

  // -------------------------------------------------------------------------
  // ignore_peer / unignore_peer / list_ignored_peers
  // -------------------------------------------------------------------------
  describe("ignored peers tools", () => {
    it("registers all three tools when ignoredPeersManager is provided", async () => {
      const manager = makeIgnoredPeersManager();
      ({ client, cleanup } = await buildClient(agora, manager));
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).toContain("ignore_peer");
      expect(names).toContain("unignore_peer");
      expect(names).toContain("list_ignored_peers");
    });

    it("does not register ignored peers tools when manager is absent", async () => {
      ({ client, cleanup } = await buildClient(agora, null));
      const { tools } = await client.listTools();
      const names = tools.map((t) => t.name);
      expect(names).not.toContain("ignore_peer");
      expect(names).not.toContain("unignore_peer");
      expect(names).not.toContain("list_ignored_peers");
    });

    it("ignore_peer adds key and list_ignored_peers reflects it", async () => {
      const manager = makeIgnoredPeersManager();
      ({ client, cleanup } = await buildClient(agora, manager));

      await client.callTool({ name: "ignore_peer", arguments: { publicKey: "peer-abc" } });
      const result = await client.callTool({ name: "list_ignored_peers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { ignoredPeers: string[] };
      expect(data.ignoredPeers).toEqual(["peer-abc"]);
    });

    it("unignore_peer removes key", async () => {
      const manager = makeIgnoredPeersManager(["peer-abc"]);
      ({ client, cleanup } = await buildClient(agora, manager));

      await client.callTool({ name: "unignore_peer", arguments: { publicKey: "peer-abc" } });
      const result = await client.callTool({ name: "list_ignored_peers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { ignoredPeers: string[] };
      expect(data.ignoredPeers).toEqual([]);
    });

    it("ignore_peer returns added:true on first add", async () => {
      const manager = makeIgnoredPeersManager();
      ({ client, cleanup } = await buildClient(agora, manager));

      const result = await client.callTool({ name: "ignore_peer", arguments: { publicKey: "new-key" } });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.added).toBe(true);
    });

    it("ignore_peer returns added:false on duplicate", async () => {
      const manager = makeIgnoredPeersManager(["dup-key"]);
      ({ client, cleanup } = await buildClient(agora, manager));

      const result = await client.callTool({ name: "ignore_peer", arguments: { publicKey: "dup-key" } });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.added).toBe(false);
    });
  });
});
