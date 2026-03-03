import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { createTinyBusMcpServer } from "../../src/mcp/TinyBusMcpServer";
import { TinyBus } from "../../src/tinybus/core/TinyBus";
import { MemoryProvider } from "../../src/tinybus/providers/MemoryProvider";
import type { IAgoraService } from "../../src/agora/IAgoraService";
import type { IgnoredPeersManager } from "../../src/mcp/TinyBusMcpServer";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockAgoraService(peers: string[] = []): IAgoraService {
  return {
    getPeers: jest.fn(() => peers),
    sendMessage: jest.fn(),
    replyToEnvelope: jest.fn(),
    decodeInbound: jest.fn(),
    getPeerConfig: jest.fn(),
    connectRelay: jest.fn(),
    disconnectRelay: jest.fn(),
    setRelayMessageHandler: jest.fn(),
    setRelayMessageHandlerWithName: jest.fn(),
    isRelayConnected: jest.fn(() => false),
  } as unknown as IAgoraService;
}

async function buildClient(
  tinyBus: TinyBus,
  agoraService?: IAgoraService | null,
  ignoredPeersManager?: IgnoredPeersManager | null,
): Promise<{ client: Client; cleanup: () => Promise<void> }> {
  const server = createTinyBusMcpServer({ tinyBus, agoraService, ignoredPeersManager });
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => {
      await client.close();
    },
  };
}

function makeIgnoredPeersManager(initial: string[] = []): IgnoredPeersManager {
  const peers = new Set(initial);
  return {
    ignorePeer: jest.fn((publicKey: string) => {
      const before = peers.size;
      peers.add(publicKey);
      return peers.size > before;
    }),
    unignorePeer: jest.fn((publicKey: string) => peers.delete(publicKey)),
    listIgnoredPeers: jest.fn(() => Array.from(peers.values()).sort()),
  };
}

async function startedBus(...providerDefs: Array<{ id: string; types?: string[] }>): Promise<TinyBus> {
  const bus = new TinyBus();
  for (const { id, types = [] } of providerDefs) {
    bus.registerProvider(new MemoryProvider(id, types));
  }
  await bus.start();
  return bus;
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("TinyBusMcpServer", () => {
  let bus: TinyBus;
  let client: Client;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup?.();
    if (bus.isStarted()) await bus.stop();
  });

  // -------------------------------------------------------------------------
  // send_message
  // -------------------------------------------------------------------------
  describe("send_message tool", () => {
    beforeEach(async () => {
      bus = await startedBus({ id: "p1", types: ["chat.message"] });
      ({ client, cleanup } = await buildClient(bus));
    });

    it("returns success with messageId when message is delivered", async () => {
      const result = await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message" },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.success).toBe(true);
      expect(typeof data.messageId).toBe("string");
    });

    it("returns messageType matching the requested type", async () => {
      const result = await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message" },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.messageType).toBe("chat.message");
    });

    it("returns a numeric timestamp", async () => {
      const result = await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message" },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(typeof data.timestamp).toBe("number");
      expect(data.timestamp as number).toBeGreaterThan(0);
    });

    it("passes payload through to TinyBus", async () => {
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message", payload: { text: "hello" } },
      });
      const sent = provider.getSentMessages();
      expect(sent[0].payload).toEqual({ text: "hello" });
    });

    it("passes meta through to TinyBus", async () => {
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message", meta: { correlationId: "abc" } },
      });
      const sent = provider.getSentMessages();
      expect(sent[0].meta).toEqual({ correlationId: "abc" });
    });

    it("passes destination through to TinyBus", async () => {
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message", destination: "p1" },
      });
      const sent = provider.getSentMessages();
      expect(sent[0].destination).toBe("p1");
    });

    it("returns success:false and error when bus publish throws", async () => {
      // Publish only throws on a non-started bus
      const stoppedBus = new TinyBus();
      const { client: c, cleanup: cl } = await buildClient(stoppedBus);
      cleanup = cl;
      const result = await c.callTool({
        name: "send_message",
        arguments: { type: "any.type" },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.success).toBe(false);
      expect(typeof data.error).toBe("string");
    });

    it("handles null payload gracefully", async () => {
      const result = await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message", payload: null },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.success).toBe(true);
    });

    it("handles complex nested payload", async () => {
      const payload = { level1: { level2: [1, 2, 3] } };
      const provider = bus.getProviders()[0] as MemoryProvider;
      await client.callTool({
        name: "send_message",
        arguments: { type: "chat.message", payload },
      });
      const sent = provider.getSentMessages();
      expect(sent[0].payload).toEqual(payload);
    });
  });

  // -------------------------------------------------------------------------
  // list_message_types
  // -------------------------------------------------------------------------
  describe("list_message_types tool", () => {
    it("returns empty allTypes and providers when no providers registered", async () => {
      bus = await startedBus();
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_message_types", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.allTypes).toEqual([]);
      expect(data.totalProviders).toBe(0);
    });

    it("returns types for a single provider", async () => {
      bus = await startedBus({ id: "p1", types: ["type.a", "type.b"] });
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_message_types", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.allTypes).toEqual(["type.a", "type.b"]);
    });

    it("merges types from multiple providers", async () => {
      bus = await startedBus(
        { id: "p1", types: ["type.a"] },
        { id: "p2", types: ["type.b"] },
      );
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_message_types", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.allTypes).toContain("type.a");
      expect(data.allTypes).toContain("type.b");
    });

    it("deduplicates overlapping types across providers", async () => {
      bus = await startedBus(
        { id: "p1", types: ["shared.event"] },
        { id: "p2", types: ["shared.event"] },
      );
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_message_types", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      const types = data.allTypes as string[];
      expect(types.filter((t) => t === "shared.event")).toHaveLength(1);
    });

    it("returns allTypes in sorted order", async () => {
      bus = await startedBus(
        { id: "p1", types: ["z.last", "a.first"] },
        { id: "p2", types: ["m.middle"] },
      );
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_message_types", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      const types = data.allTypes as string[];
      expect(types).toEqual([...types].sort());
    });

    it("includes per-provider breakdown in providers field", async () => {
      bus = await startedBus(
        { id: "provA", types: ["x.type"] },
        { id: "provB", types: ["y.type"] },
      );
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_message_types", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, Record<string, string[]>>;
      expect(data.providers["provA"]).toEqual(["x.type"]);
      expect(data.providers["provB"]).toEqual(["y.type"]);
    });

    it("reports correct totalProviders count", async () => {
      bus = await startedBus({ id: "p1" }, { id: "p2" }, { id: "p3" });
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_message_types", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.totalProviders).toBe(3);
    });
  });

  // -------------------------------------------------------------------------
  // list_providers
  // -------------------------------------------------------------------------
  describe("list_providers tool", () => {
    it("returns empty providers list when no providers registered", async () => {
      bus = await startedBus();
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_providers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.providers).toEqual([]);
      expect(data.totalProviders).toBe(0);
    });

    it("reports busStarted:true when bus is started", async () => {
      bus = await startedBus({ id: "p1" });
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_providers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.busStarted).toBe(true);
    });

    it("reports busStarted:false when bus is not started", async () => {
      bus = new TinyBus();
      bus.registerProvider(new MemoryProvider("p1"));
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_providers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.busStarted).toBe(false);
    });

    it("includes provider id in each provider entry", async () => {
      bus = await startedBus({ id: "my-provider" });
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_providers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { providers: Array<{ id: string }> };
      expect(data.providers[0].id).toBe("my-provider");
    });

    it("includes messageTypes in each provider entry", async () => {
      bus = await startedBus({ id: "p1", types: ["msg.type.x"] });
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_providers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { providers: Array<{ messageTypes: string[] }> };
      expect(data.providers[0].messageTypes).toEqual(["msg.type.x"]);
    });

    it("includes isStarted flag per provider entry reflecting bus state", async () => {
      bus = await startedBus({ id: "p1" });
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_providers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { providers: Array<{ isStarted: boolean }> };
      expect(data.providers[0].isStarted).toBe(true);
    });

    it("lists all registered providers", async () => {
      bus = await startedBus({ id: "alpha" }, { id: "beta" }, { id: "gamma" });
      ({ client, cleanup } = await buildClient(bus));
      const result = await client.callTool({ name: "list_providers", arguments: {} });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { providers: Array<{ id: string }> };
      const ids = data.providers.map((p) => p.id);
      expect(ids).toContain("alpha");
      expect(ids).toContain("beta");
      expect(ids).toContain("gamma");
    });
  });

  // -------------------------------------------------------------------------
  // tool listing / discovery
  // -------------------------------------------------------------------------
  describe("tool discovery", () => {
    it("always exposes send_message, list_message_types, list_providers tools", async () => {
      bus = await startedBus();
      ({ client, cleanup } = await buildClient(bus));
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("send_message");
      expect(names).toContain("list_message_types");
      expect(names).toContain("list_providers");
    });

    it("does not expose Agora tools when no agoraService provided", async () => {
      bus = await startedBus();
      ({ client, cleanup } = await buildClient(bus, null));
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).not.toContain("send_agora_message");
      expect(names).not.toContain("list_peers");
      expect(names).not.toContain("ignore_peer");
    });

    it("exposes Agora tools when agoraService is provided", async () => {
      bus = await startedBus();
      ({ client, cleanup } = await buildClient(bus, makeMockAgoraService()));
      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toContain("send_agora_message");
      expect(names).toContain("list_peers");
    });

    it("deprecated single-arg overload still creates a working server", async () => {
      const { createTinyBusMcpServer: createFn } = await import("../../src/mcp/TinyBusMcpServer");
      bus = await startedBus({ id: "p1" });
      const server = createFn(bus);
      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const c = new Client({ name: "t", version: "1" });
      await c.connect(ct);
      const result = await c.callTool({
        name: "send_message",
        arguments: { type: "chat.message" },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as Record<string, unknown>;
      expect(data.success).toBe(true);
      cleanup = async () => { await c.close(); };
    });
  });
});
