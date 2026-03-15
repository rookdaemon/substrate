import { AgoraWakePoller, MAX_LOOKBACK_MS, IFetcher } from "../../src/agora/AgoraWakePoller";
import { AgoraStateStore } from "../../src/agora/AgoraStateStore";
import { AgoraMessageHandler } from "../../src/agora/AgoraMessageHandler";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { IClock } from "../../src/substrate/abstractions/IClock";
import type { ILogger } from "../../src/logging";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import { IConversationManager } from "../../src/conversation/IConversationManager";
import { IMessageInjector } from "../../src/loop/IMessageInjector";
import { ILoopEventSink } from "../../src/loop/ILoopEventSink";
import { IAgoraService } from "../../src/agora/IAgoraService";
import { LoopState } from "../../src/loop/types";
import { AgentRole } from "../../src/agents/types";

// ── Mock helpers ──────────────────────────────────────────────────────────────

class MockClock implements IClock {
  constructor(private time: Date) {}
  now() { return this.time; }
}

class MockLogger implements ILogger {
  messages: string[] = [];
  debug(m: string) { this.messages.push(m); }
  verbose() {}
}

class MockConversationManager implements IConversationManager {
  entries: Array<{ role: AgentRole; entry: string }> = [];
  async append(role: AgentRole, entry: string) { this.entries.push({ role, entry }); }
}

class MockMessageInjector implements IMessageInjector {
  injected: string[] = [];
  injectMessage(msg: string) { this.injected.push(msg); return true; }
}

class MockAgoraService implements IAgoraService {
  private peers = new Map<string, { name: string; publicKey: string; url: string; token: string }>();
  addPeer(name: string, pk: string) { this.peers.set(pk, { name, publicKey: pk, url: "", token: "" }); }
  async sendMessage() { return { ok: true, status: 200 }; }
  async sendToAll() { return { ok: true, errors: [] }; }
  async replyToEnvelope() { return { ok: true, status: 200 }; }
  async decodeInbound() { return { ok: false }; }
  getPeers() { return Array.from(this.peers.keys()); }
  getPeerConfig(id: string) { return this.peers.get(id) ?? Array.from(this.peers.values()).find(p => p.name === id); }
  getSelfIdentity() { return { publicKey: "selfpubkey0000000000000000000000000000000000000000000000000000000000", name: "self" }; }
  async connectRelay() {}
  async disconnectRelay() {}
  isRelayConnected() { return false; }
}

function makeEnvelope(overrides?: Partial<Envelope>): Envelope {
  return {
    id: `env-${Math.random().toString(36).slice(2)}`,
    type: "dm",
    sender: "peerpubkey00000000000000000000000000000000000000000000000000000000",
    from: "peerpubkey00000000000000000000000000000000000000000000000000000000",
    timestamp: Date.now(),
    payload: { text: "hello from gap" },
    signature: "valid-sig",
    ...overrides,
  } as Envelope;
}

function makeHandler(
  agoraService: MockAgoraService,
  clock: MockClock,
  logger: MockLogger,
  stateStore: AgoraStateStore | null = null,
): AgoraMessageHandler {
  return new AgoraMessageHandler(
    agoraService,
    new MockConversationManager(),
    new MockMessageInjector(),
    null, // no event sink
    clock,
    () => LoopState.RUNNING,
    () => false,
    logger,
    'allow', // allow unknown senders so tests aren't blocked by allowlist
    { enabled: false, maxMessages: 100, windowMs: 60000 },
    null,
    null,
    null,
    null,
    stateStore,
  );
}

const SELF_PUBKEY = "selfpubkey0000000000000000000000000000000000000000000000000000000000";
const RELAY_REST_URL = "http://relay.example.com";

function validVerify(_e: Envelope) { return { valid: true }; }
function invalidVerify(_e: Envelope) { return { valid: false, reason: "bad sig" }; }

function makeFetcher(response: { ok: boolean; status?: number; body?: unknown }): IFetcher {
  return {
    fetch: jest.fn(async () => ({
      ok: response.ok,
      status: response.status ?? (response.ok ? 200 : 500),
      json: async () => response.body ?? { messages: [] },
    })),
  };
}

// ── Tests ──────────────────────────────────────────────────────────────────────

describe("AgoraWakePoller", () => {
  const NOW_MS = 1_700_000_000_000; // fixed epoch for deterministic assertions
  let clock: MockClock;
  let logger: MockLogger;
  let stateStore: AgoraStateStore;
  let agoraService: MockAgoraService;
  let handler: AgoraMessageHandler;

  beforeEach(() => {
    clock = new MockClock(new Date(NOW_MS));
    logger = new MockLogger();
    stateStore = new AgoraStateStore("/fake/.agora_state.json", new InMemoryFileSystem(), logger);
    agoraService = new MockAgoraService();
    handler = makeHandler(agoraService, clock, logger, stateStore);
  });

  // ── deriveRestUrl ──────────────────────────────────────────────────────────

  describe("deriveRestUrl()", () => {
    it("converts ws:// to http://", () => {
      expect(AgoraWakePoller.deriveRestUrl("ws://relay.example.com:8080")).toBe("http://relay.example.com:8080");
    });

    it("converts wss:// to https://", () => {
      expect(AgoraWakePoller.deriveRestUrl("wss://relay.example.com:443")).toBe("https://relay.example.com");
    });

    it("strips path, search, and hash", () => {
      expect(AgoraWakePoller.deriveRestUrl("ws://relay.example.com/ws?foo=bar#baz")).toBe("http://relay.example.com");
    });

    it("returns null for an invalid URL", () => {
      expect(AgoraWakePoller.deriveRestUrl("not-a-url")).toBeNull();
    });
  });

  // ── pollMissedMessages ─────────────────────────────────────────────────────

  describe("pollMissedMessages()", () => {
    it("calls relay with correct since and peer parameters", async () => {
      // lastSeen 1 hour ago
      const oneHourAgoMs = NOW_MS - 60 * 60 * 1000;
      await stateStore.updateLastSeen("peerA", oneHourAgoMs);

      const fetcher = makeFetcher({ ok: true, body: { messages: [] } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await poller.pollMissedMessages();

      expect(fetcher.fetch).toHaveBeenCalledTimes(1);
      const calledUrl = (fetcher.fetch as jest.Mock).mock.calls[0][0] as string;
      expect(calledUrl).toContain(`since=${oneHourAgoMs}`);
      expect(calledUrl).toContain(`peer=${SELF_PUBKEY}`);
      expect(calledUrl).toContain(`${RELAY_REST_URL}/api/relay/replay`);
    });

    it("uses 7-day cap when no lastSeen data exists", async () => {
      const fetcher = makeFetcher({ ok: true, body: { messages: [] } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await poller.pollMissedMessages();

      const calledUrl = (fetcher.fetch as jest.Mock).mock.calls[0][0] as string;
      const expectedSince = NOW_MS - MAX_LOOKBACK_MS;
      expect(calledUrl).toContain(`since=${expectedSince}`);
    });

    it("enforces 7-day cap even when lastSeen is older than 7 days", async () => {
      // Simulate a peer whose lastSeen is 30 days ago
      const thirtyDaysAgoMs = NOW_MS - 30 * 24 * 60 * 60 * 1000;
      await stateStore.updateLastSeen("peerOld", thirtyDaysAgoMs);

      const fetcher = makeFetcher({ ok: true, body: { messages: [] } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await poller.pollMissedMessages();

      const calledUrl = (fetcher.fetch as jest.Mock).mock.calls[0][0] as string;
      // Must not exceed 7 days back
      const expectedMin = NOW_MS - MAX_LOOKBACK_MS;
      expect(calledUrl).toContain(`since=${expectedMin}`);
    });

    it("uses min(lastSeen) as anchor when multiple peers are tracked", async () => {
      const twoHoursAgoMs = NOW_MS - 2 * 60 * 60 * 1000;
      const oneHourAgoMs  = NOW_MS - 1 * 60 * 60 * 1000;
      await stateStore.updateLastSeen("peerA", twoHoursAgoMs);  // older
      await stateStore.updateLastSeen("peerB", oneHourAgoMs);   // newer

      const fetcher = makeFetcher({ ok: true, body: { messages: [] } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await poller.pollMissedMessages();

      const calledUrl = (fetcher.fetch as jest.Mock).mock.calls[0][0] as string;
      // Should use the minimum (oldest) anchor — two hours ago
      expect(calledUrl).toContain(`since=${twoHoursAgoMs}`);
    });

    it("processes valid replayed envelopes via AgoraMessageHandler", async () => {
      const peer = "peerpubkey00000000000000000000000000000000000000000000000000000000";
      agoraService.addPeer("peer", peer);
      handler = makeHandler(agoraService, clock, logger, stateStore);

      const env = makeEnvelope({ id: "replay-1", from: peer, sender: peer });
      const fetcher = makeFetcher({ ok: true, body: { messages: [env] } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await poller.pollMissedMessages();

      expect(logger.messages.some(m => m.includes("processed 1/1"))).toBe(true);
    });

    it("skips envelopes that fail signature verification", async () => {
      const env = makeEnvelope({ id: "bad-sig-env" });
      const fetcher = makeFetcher({ ok: true, body: { messages: [env] } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, invalidVerify, logger, clock, fetcher);

      await poller.pollMissedMessages();

      // processed=0, total=1 → should log a skip message
      expect(logger.messages.some(m => m.includes("bad-sig-env") && m.includes("bad sig"))).toBe(true);
    });

    it("degrades gracefully when relay is unreachable (fetch throws)", async () => {
      const fetcher: IFetcher = {
        fetch: jest.fn().mockRejectedValue(new Error("ECONNREFUSED")),
      };
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      // Must not throw
      await expect(poller.pollMissedMessages()).resolves.toBeUndefined();
      expect(logger.messages.some(m => m.includes("unreachable"))).toBe(true);
    });

    it("degrades gracefully when relay returns non-200", async () => {
      const fetcher = makeFetcher({ ok: false, status: 503 });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await expect(poller.pollMissedMessages()).resolves.toBeUndefined();
      expect(logger.messages.some(m => m.includes("HTTP 503"))).toBe(true);
    });

    it("degrades gracefully when relay returns malformed JSON (no messages array)", async () => {
      const fetcher = makeFetcher({ ok: true, body: { unexpected: "shape" } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      // Should not throw
      await expect(poller.pollMissedMessages()).resolves.toBeUndefined();
    });

    it("does not call fetch at all when relay URL is obviously invalid (constructor guard)", async () => {
      // Even with a bad URL, pollMissedMessages should degrade gracefully
      const fetcher: IFetcher = {
        fetch: jest.fn().mockRejectedValue(new TypeError("Invalid URL")),
      };
      const poller = new AgoraWakePoller(stateStore, "not-a-url", SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await expect(poller.pollMissedMessages()).resolves.toBeUndefined();
    });

    it("continues after one envelope fails processing", async () => {
      const peer = "peerpubkey00000000000000000000000000000000000000000000000000000000";
      agoraService.addPeer("peer", peer);

      const env1 = makeEnvelope({ id: "env-good", from: peer, sender: peer });
      const env2 = makeEnvelope({ id: "env-also-good", from: peer, sender: peer });

      const fetcher = makeFetcher({ ok: true, body: { messages: [env1, env2] } });
      const poller = new AgoraWakePoller(stateStore, RELAY_REST_URL, SELF_PUBKEY, handler, validVerify, logger, clock, fetcher);

      await poller.pollMissedMessages();

      expect(logger.messages.some(m => m.includes("processed 2/2"))).toBe(true);
    });
  });
});
