import { PeerAvailabilityMonitor, PeerConfig } from "../../src/loop/PeerAvailabilityMonitor";
import type { IMessageInjector } from "../../src/loop/IMessageInjector";
import type { ILogger } from "../../src/logging";

// ---------- Helpers ----------

function makeInjector(): IMessageInjector & { messages: string[] } {
  const messages: string[] = [];
  return {
    messages,
    injectMessage(msg: string): boolean {
      messages.push(msg);
      return true;
    },
  };
}

function makeLogger(): ILogger {
  return {
    info: () => {},
    debug: () => {},
    error: () => {},
    warn: () => {},
  } as unknown as ILogger;
}

type FakeFetchResult = {
  ok: boolean;
  body?: Record<string, unknown>;
};

function makeFetch(responses: Map<string, FakeFetchResult>) {
  return async (url: string) => {
    const r = responses.get(url);
    if (!r) {
      throw new Error(`connect ECONNREFUSED ${url}`);
    }
    return {
      ok: r.ok,
      json: async () => r.body ?? {},
    };
  };
}

const PEER_BISHOP: PeerConfig = { name: "bishop", port: 3001 };
const PEER_NOVA: PeerConfig = { name: "nova", port: 3002 };

// ---------- readPeerStatus ----------

describe("PeerAvailabilityMonitor.readPeerStatus", () => {
  it("returns online status with rateLimitUntil when peer is rate-limited", async () => {
    const rlu = "2026-03-09T10:00:00.000Z";
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RATE_LIMITED", rateLimitUntil: rlu, meta: { name: "bishop" } },
      }],
    ]);
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      makeInjector(),
      makeLogger(),
      makeFetch(responses),
    );
    const status = await monitor.readPeerStatus(3001, "bishop");
    expect(status.online).toBe(true);
    expect(status.rateLimitUntil).toBe(rlu);
    expect(status.state).toBe("RATE_LIMITED");
    expect(status.name).toBe("bishop");
  });

  it("returns online status with null rateLimitUntil for ACTIVE peer", async () => {
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RUNNING", meta: { name: "bishop" } },
      }],
    ]);
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      makeInjector(),
      makeLogger(),
      makeFetch(responses),
    );
    const status = await monitor.readPeerStatus(3001, "bishop");
    expect(status.online).toBe(true);
    expect(status.rateLimitUntil).toBeNull();
    expect(status.state).toBe("RUNNING");
  });

  it("returns offline status on connection refused", async () => {
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      makeInjector(),
      makeLogger(),
      makeFetch(new Map()),
    );
    const status = await monitor.readPeerStatus(3001, "bishop");
    expect(status.online).toBe(false);
    expect(status.state).toBe("OFFLINE");
    expect(status.rateLimitUntil).toBeNull();
  });

  it("uses fallback name when meta.name is absent", async () => {
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RUNNING" },
      }],
    ]);
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      makeInjector(),
      makeLogger(),
      makeFetch(responses),
    );
    const status = await monitor.readPeerStatus(3001, "bishop");
    expect(status.name).toBe("bishop");
  });

  it("returns offline for non-ok HTTP response", async () => {
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, { ok: false }],
    ]);
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      makeInjector(),
      makeLogger(),
      makeFetch(responses),
    );
    const status = await monitor.readPeerStatus(3001, "bishop");
    expect(status.online).toBe(false);
    expect(status.rateLimitUntil).toBeNull();
  });
});

// ---------- scanAll ----------

describe("PeerAvailabilityMonitor.scanAll", () => {
  it("injects RATE_LIMITED status for rate-limited peers on startup", async () => {
    const rlu = "2026-03-09T10:00:00.000Z";
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RATE_LIMITED", rateLimitUntil: rlu, meta: { name: "bishop" } },
      }],
      [`http://localhost:3002/api/loop/status`, {
        ok: true,
        body: { state: "RUNNING", meta: { name: "nova" } },
      }],
    ]);
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP, PEER_NOVA],
      injector,
      makeLogger(),
      makeFetch(responses),
    );
    await monitor.scanAll();
    expect(injector.messages).toHaveLength(1);
    expect(injector.messages[0]).toBe(`[PEER STATUS] bishop: RATE_LIMITED until ${rlu}`);
  });

  it("does not inject anything when no peers are rate-limited", async () => {
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RUNNING", meta: { name: "bishop" } },
      }],
    ]);
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(responses),
    );
    await monitor.scanAll();
    expect(injector.messages).toHaveLength(0);
  });

  it("handles offline peers gracefully (no crash, no injection)", async () => {
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(new Map()),
    );
    await expect(monitor.scanAll()).resolves.toBeUndefined();
    expect(injector.messages).toHaveLength(0);
  });

  it("does not re-inject the same rate limit event", async () => {
    const rlu = "2026-03-09T10:00:00.000Z";
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RATE_LIMITED", rateLimitUntil: rlu, meta: { name: "bishop" } },
      }],
    ]);
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(responses),
    );
    await monitor.scanAll();
    await monitor.scanAll();
    expect(injector.messages).toHaveLength(1);
  });

  it("re-injects when a new rate limit occurs after recovery", async () => {
    const rlu1 = "2026-03-09T10:00:00.000Z";
    const rlu2 = "2026-03-09T12:00:00.000Z";
    let body: Record<string, unknown> = { state: "RATE_LIMITED", rateLimitUntil: rlu1, meta: { name: "bishop" } };
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, { ok: true, get body() { return body; } }],
    ]);
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(responses),
    );
    await monitor.scanAll();
    // simulate recovery
    body = { state: "RUNNING", meta: { name: "bishop" } };
    await monitor.scanAll();
    // simulate new rate limit
    body = { state: "RATE_LIMITED", rateLimitUntil: rlu2, meta: { name: "bishop" } };
    await monitor.scanAll();
    // First rate limit + new rate limit = 2 injections (ACTIVE is injected during onContactFailed, not scanAll)
    expect(injector.messages).toHaveLength(2);
    expect(injector.messages[0]).toContain(rlu1);
    expect(injector.messages[1]).toContain(rlu2);
  });
});

// ---------- onContactFailed ----------

describe("PeerAvailabilityMonitor.onContactFailed", () => {
  it("injects RATE_LIMITED status when peer is rate-limited after failed contact", async () => {
    const rlu = "2026-03-09T10:00:00.000Z";
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RATE_LIMITED", rateLimitUntil: rlu, meta: { name: "bishop" } },
      }],
    ]);
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(responses),
    );
    await monitor.onContactFailed("bishop");
    expect(injector.messages).toHaveLength(1);
    expect(injector.messages[0]).toBe(`[PEER STATUS] bishop: RATE_LIMITED until ${rlu}`);
  });

  it("injects ACTIVE status when peer is reachable but not rate-limited", async () => {
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RUNNING", meta: { name: "bishop" } },
      }],
    ]);
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(responses),
    );
    await monitor.onContactFailed("bishop");
    expect(injector.messages).toHaveLength(1);
    expect(injector.messages[0]).toBe("[PEER STATUS] bishop: ACTIVE");
  });

  it("handles offline peer gracefully (no crash, no injection)", async () => {
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(new Map()),
    );
    await expect(monitor.onContactFailed("bishop")).resolves.toBeUndefined();
    expect(injector.messages).toHaveLength(0);
  });

  it("does nothing for unknown peer name", async () => {
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(new Map()),
    );
    await monitor.onContactFailed("unknownpeer");
    expect(injector.messages).toHaveLength(0);
  });

  it("does not re-inject the same ACTIVE status", async () => {
    const responses = new Map([
      [`http://localhost:3001/api/loop/status`, {
        ok: true,
        body: { state: "RUNNING", meta: { name: "bishop" } },
      }],
    ]);
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(responses),
    );
    await monitor.onContactFailed("bishop");
    await monitor.onContactFailed("bishop");
    expect(injector.messages).toHaveLength(1);
  });

  it("does not inject for offline peer even on repeated failed contacts", async () => {
    const injector = makeInjector();
    const monitor = new PeerAvailabilityMonitor(
      [PEER_BISHOP],
      injector,
      makeLogger(),
      makeFetch(new Map()),
    );
    await monitor.onContactFailed("bishop");
    await monitor.onContactFailed("bishop");
    expect(injector.messages).toHaveLength(0);
  });
});
