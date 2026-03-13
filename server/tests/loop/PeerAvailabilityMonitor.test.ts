import { PeerAvailabilityMonitor, PeerConfig, IPeerMonitorFileSystem } from "../../src/loop/PeerAvailabilityMonitor";
import type { IMessageInjector } from "../../src/loop/IMessageInjector";
import type { ILogger } from "../../src/logging";

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
        info: () => { },
        debug: () => { },
        error: () => { },
        warn: () => { },
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

const PEER_BISHOP: PeerConfig = { peerId: "bishop", apiStatusUrl: "http://localhost:3001/api/loop/status" };
const PEER_NOVA: PeerConfig = { peerId: "nova", apiStatusUrl: "http://localhost:3002/api/loop/status" };

describe("PeerAvailabilityMonitor.readPeerStatus", () => {
    it("returns online status with rateLimitUntil when peer is rate-limited", async () => {
        const rlu = "2026-03-09T10:00:00.000Z";
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, {
                ok: true,
                body: { state: "RATE_LIMITED", rateLimitUntil: rlu, meta: { name: "bishop" } },
            }],
        ]);

        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], makeInjector(), makeLogger(), makeFetch(responses));
        const status = await monitor.readPeerStatus(PEER_BISHOP);

        expect(status.online).toBe(true);
        expect(status.rateLimitUntil).toBe(rlu);
        expect(status.state).toBe("RATE_LIMITED");
        expect(status.peerId).toBe("bishop");
    });

    it("returns offline status on connection refused", async () => {
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], makeInjector(), makeLogger(), makeFetch(new Map()));
        const status = await monitor.readPeerStatus(PEER_BISHOP);

        expect(status.online).toBe(false);
        expect(status.state).toBe("OFFLINE");
        expect(status.rateLimitUntil).toBeNull();
    });
});

describe("PeerAvailabilityMonitor.scanAll", () => {
    it("injects active rate limits using rateLimitedUntil[peerId] format", async () => {
        const now = new Date("2026-03-09T09:00:00.000Z");
        const rlu = "2026-03-09T10:00:00.000Z";
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, {
                ok: true,
                body: { state: "RATE_LIMITED", rateLimitUntil: rlu },
            }],
            [PEER_NOVA.apiStatusUrl, {
                ok: true,
                body: { state: "RUNNING" },
            }],
        ]);
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP, PEER_NOVA], injector, makeLogger(), makeFetch(responses));

        await monitor.scanAll(now);

        expect(injector.messages).toEqual([
            `[PEER RATE LIMIT] rateLimitedUntil[bishop]=${rlu}`,
        ]);
    });

    it("does not inject expired rate limits", async () => {
        const now = new Date("2026-03-09T11:00:00.000Z");
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, {
                ok: true,
                body: { state: "RATE_LIMITED", rateLimitUntil: "2026-03-09T10:00:00.000Z" },
            }],
        ]);
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses));

        await monitor.scanAll(now);
        expect(injector.messages).toHaveLength(0);
    });

    it("does not re-inject the same active rate limit in later scans", async () => {
        const now = new Date("2026-03-09T09:00:00.000Z");
        const rlu = "2026-03-09T10:00:00.000Z";
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, {
                ok: true,
                body: { state: "RATE_LIMITED", rateLimitUntil: rlu },
            }],
        ]);
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses));

        await monitor.scanAll(now);
        await monitor.scanAll(now);
        expect(injector.messages).toHaveLength(1);
    });

    it("injects [PEER RATE LIMIT CLEARED] when rate limit clears", async () => {
        const rlu = "2026-03-09T10:00:00.000Z";

        let body: Record<string, unknown> = { state: "RATE_LIMITED", rateLimitUntil: rlu };
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, { ok: true, get body() { return body; } }],
        ]);
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses));

        await monitor.scanAll(new Date("2026-03-09T09:00:00.000Z"));
        body = { state: "RUNNING" };
        await monitor.scanAll(new Date("2026-03-09T11:00:00.000Z"));

        expect(injector.messages).toEqual([
            `[PEER RATE LIMIT] rateLimitedUntil[bishop]=${rlu}`,
            `[PEER RATE LIMIT CLEARED] peerId=bishop`,
        ]);
    });

    it("re-injects when a new rate limit timestamp appears", async () => {
        const now = new Date("2026-03-09T09:00:00.000Z");
        const rlu1 = "2026-03-09T10:00:00.000Z";
        const rlu2 = "2026-03-09T12:00:00.000Z";

        let body: Record<string, unknown> = { state: "RATE_LIMITED", rateLimitUntil: rlu1 };
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, { ok: true, get body() { return body; } }],
        ]);

        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses));

        await monitor.scanAll(now);
        body = { state: "RUNNING" };
        await monitor.scanAll(new Date("2026-03-09T10:30:00.000Z"));
        body = { state: "RATE_LIMITED", rateLimitUntil: rlu2 };
        await monitor.scanAll(now);

        expect(injector.messages).toEqual([
            `[PEER RATE LIMIT] rateLimitedUntil[bishop]=${rlu1}`,
            `[PEER RATE LIMIT CLEARED] peerId=bishop`,
            `[PEER RATE LIMIT] rateLimitedUntil[bishop]=${rlu2}`,
        ]);
    });
});

describe("PeerAvailabilityMonitor.onContactFailed", () => {
    it("injects only active rate-limited status", async () => {
        const now = new Date("2026-03-09T09:00:00.000Z");
        const rlu = "2026-03-09T10:00:00.000Z";
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, {
                ok: true,
                body: { state: "RATE_LIMITED", rateLimitUntil: rlu },
            }],
        ]);

        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses));

        await monitor.onContactFailed("bishop", now);
        expect(injector.messages).toEqual([
            `[PEER RATE LIMIT] rateLimitedUntil[bishop]=${rlu}`,
        ]);
    });

    it("does not inject ACTIVE status", async () => {
        const now = new Date("2026-03-09T09:00:00.000Z");
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, {
                ok: true,
                body: { state: "RUNNING" },
            }],
        ]);

        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses));

        await monitor.onContactFailed("bishop", now);
        expect(injector.messages).toHaveLength(0);
    });
});

describe("PeerAvailabilityMonitor: state persistence", () => {
    function makeFileSystem(initial?: Record<string, string>): IPeerMonitorFileSystem & { files: Map<string, string> } {
        const files = new Map<string, string>(Object.entries(initial ?? {}));
        return {
            files,
            async readFile(p: string): Promise<string> {
                const content = files.get(p);
                if (content === undefined) throw new Error(`ENOENT: ${p}`);
                return content;
            },
            async writeFile(p: string, content: string): Promise<void> {
                files.set(p, content);
            },
        };
    }

    const rlu = "2026-03-09T10:00:00.000Z";
    const now = new Date("2026-03-09T09:00:00.000Z");
    const STATE_PATH = "/state/.peer-monitor-state.json";

    it("loadState() restores active rate limits from disk", async () => {
        const fileSystem = makeFileSystem({
            [STATE_PATH]: JSON.stringify({ bishop: rlu }),
        });
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), undefined, fileSystem, STATE_PATH);

        await monitor.loadState(now);

        // Simulate a scan that returns the same rate limit — should NOT re-inject
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, { ok: true, body: { state: "RATE_LIMITED", rateLimitUntil: rlu } }],
        ]);
        const monitorWithFetch = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses), fileSystem, STATE_PATH);
        await monitorWithFetch.loadState(now);
        await monitorWithFetch.scanAll(now);
        expect(injector.messages).toHaveLength(0);
    });

    it("loadState() does not restore expired rate limits", async () => {
        const expiredRlu = "2026-03-09T08:00:00.000Z"; // before `now`
        const fileSystem = makeFileSystem({
            [STATE_PATH]: JSON.stringify({ bishop: expiredRlu }),
        });
        const injector = makeInjector();
        // After loading, the expired entry is discarded — a fresh scan should re-inject if active
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, { ok: true, body: { state: "RATE_LIMITED", rateLimitUntil: rlu } }],
        ]);
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses), fileSystem, STATE_PATH);
        await monitor.loadState(now);
        await monitor.scanAll(now);
        // Should inject because expired entry was not restored, so it looks like a new rate limit
        expect(injector.messages).toHaveLength(1);
    });

    it("scanAll() persists updated rate limits to disk", async () => {
        const fileSystem = makeFileSystem();
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, { ok: true, body: { state: "RATE_LIMITED", rateLimitUntil: rlu } }],
        ]);
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses), fileSystem, STATE_PATH);

        await monitor.scanAll(now);

        const saved = JSON.parse(fileSystem.files.get(STATE_PATH) ?? "{}") as Record<string, string>;
        expect(saved["bishop"]).toBe(rlu);
    });

    it("scanAll() removes expired entry from persisted state when peer recovers", async () => {
        const fileSystem = makeFileSystem({
            [STATE_PATH]: JSON.stringify({ bishop: rlu }),
        });
        // Peer has recovered (no rate limit)
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, { ok: true, body: { state: "RUNNING" } }],
        ]);
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses), fileSystem, STATE_PATH);
        await monitor.loadState(now);
        await monitor.scanAll(new Date("2026-03-09T11:00:00.000Z")); // after rlu expiry

        const saved = JSON.parse(fileSystem.files.get(STATE_PATH) ?? "{}") as Record<string, string>;
        expect(saved["bishop"]).toBeUndefined();
        expect(injector.messages).toEqual([`[PEER RATE LIMIT CLEARED] peerId=bishop`]);
    });

    it("onContactFailed() persists state to disk", async () => {
        const fileSystem = makeFileSystem();
        const responses = new Map([
            [PEER_BISHOP.apiStatusUrl, { ok: true, body: { state: "RATE_LIMITED", rateLimitUntil: rlu } }],
        ]);
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), makeFetch(responses), fileSystem, STATE_PATH);

        await monitor.onContactFailed("bishop", now);

        const saved = JSON.parse(fileSystem.files.get(STATE_PATH) ?? "{}") as Record<string, string>;
        expect(saved["bishop"]).toBe(rlu);
    });

    it("loadState() is a no-op when statePath is not configured", async () => {
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger());
        // Should not throw
        await expect(monitor.loadState(now)).resolves.toBeUndefined();
    });

    it("loadState() is a no-op when state file does not exist", async () => {
        const fileSystem = makeFileSystem(); // empty — no state file
        const injector = makeInjector();
        const monitor = new PeerAvailabilityMonitor([PEER_BISHOP], injector, makeLogger(), undefined, fileSystem, STATE_PATH);
        // Should not throw
        await expect(monitor.loadState(now)).resolves.toBeUndefined();
    });
});
