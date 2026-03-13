import { PeerAvailabilityCondition, PeerAvailabilityConditionConfig } from "../../src/loop/PeerAvailabilityCondition";
import type { ILogger } from "../../src/logging";

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

function makeFetch(result: FakeFetchResult) {
    return async (_url: string) => ({
        ok: result.ok,
        json: async () => result.body ?? {},
    });
}

function makeOfflineFetch() {
    return async (_url: string): Promise<never> => {
        throw new Error("connect ECONNREFUSED");
    };
}

const PEER_NOVA: PeerAvailabilityConditionConfig = { peerId: "nova", apiStatusUrl: "http://nova/api/loop/status" };
const PEER_BISHOP: PeerAvailabilityConditionConfig = { peerId: "bishop", apiStatusUrl: "http://bishop/api/loop/status" };

describe("PeerAvailabilityCondition: edge-trigger behavior", () => {
    it("fires on first evaluation when peer is available (false→true transition)", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), makeFetch({ ok: true }));
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("does not fire on second evaluation when peer stays available", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), makeFetch({ ok: true }));
        await condition.evaluate("peer:nova.available"); // first: fires
        expect(await condition.evaluate("peer:nova.available")).toBe(false); // stable: no edge
    });

    it("does not fire when peer starts offline", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), makeOfflineFetch());
        expect(await condition.evaluate("peer:nova.available")).toBe(false);
    });

    it("does not fire on consecutive offline evaluations", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), makeOfflineFetch());
        await condition.evaluate("peer:nova.available");
        expect(await condition.evaluate("peer:nova.available")).toBe(false);
    });

    it("re-fires when peer goes offline then comes back online", async () => {
        let available = true;
        const fetch = async (_url: string) => ({
            ok: true,
            json: async () => ({
                rateLimitUntil: available ? null : "2099-01-01T00:00:00Z",
            }),
        });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);

        await condition.evaluate("peer:nova.available"); // fires (false→true)
        available = false;
        await condition.evaluate("peer:nova.available"); // goes offline: no fire
        available = true;
        expect(await condition.evaluate("peer:nova.available")).toBe(true); // re-fires
    });

    it("tracks state independently for each peer", async () => {
        let novaAvailable = true;
        let bishopAvailable = false;
        const fetch = async (url: string) => ({
            ok: true,
            json: async () => ({
                rateLimitUntil: (url.includes("nova") ? novaAvailable : bishopAvailable) ? null : "2099-01-01T00:00:00Z",
            }),
        });
        const condition = new PeerAvailabilityCondition([PEER_NOVA, PEER_BISHOP], makeLogger(), fetch);

        // Nova fires, bishop doesn't
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
        expect(await condition.evaluate("peer:bishop.available")).toBe(false);

        // Nova stays available (no re-fire), bishop comes online (fires)
        bishopAvailable = true;
        expect(await condition.evaluate("peer:nova.available")).toBe(false);
        expect(await condition.evaluate("peer:bishop.available")).toBe(true);
    });
});

describe("PeerAvailabilityCondition: rate-limit timestamp parsing", () => {
    const FIXED_NOW_MS = new Date("2026-03-12T12:00:00.000Z").getTime();

    beforeEach(() => {
        jest.spyOn(Date, "now").mockReturnValue(FIXED_NOW_MS);
    });

    afterEach(() => {
        jest.restoreAllMocks();
    });

    it("treats peer as available when rateLimitUntil is null", async () => {
        const fetch = makeFetch({ ok: true, body: { rateLimitUntil: null } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("treats peer as available when rateLimitUntil is absent from response", async () => {
        const fetch = makeFetch({ ok: true, body: {} });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("treats peer as unavailable when rateLimitUntil is 1ms in the future", async () => {
        const rateLimitUntil = new Date(FIXED_NOW_MS + 1).toISOString();
        const fetch = makeFetch({ ok: true, body: { rateLimitUntil } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(false);
    });

    it("treats peer as available when rateLimitUntil is exactly now (boundary: not strictly greater)", async () => {
        const rateLimitUntil = new Date(FIXED_NOW_MS).toISOString();
        const fetch = makeFetch({ ok: true, body: { rateLimitUntil } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("treats peer as available when rateLimitUntil is 1ms in the past", async () => {
        const rateLimitUntil = new Date(FIXED_NOW_MS - 1).toISOString();
        const fetch = makeFetch({ ok: true, body: { rateLimitUntil } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("treats peer as unavailable when rateLimitUntil is far in the future", async () => {
        const fetch = makeFetch({ ok: true, body: { rateLimitUntil: "2099-01-01T00:00:00.000Z" } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(false);
    });

    it("treats peer as available when rateLimitUntil is an invalid (non-parseable) string", async () => {
        const fetch = makeFetch({ ok: true, body: { rateLimitUntil: "not-a-date" } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        // Date.parse("not-a-date") → NaN → !isFinite → skip check → available
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("treats rateLimitUntil as absent when it is a non-string type (number)", async () => {
        const fetch = makeFetch({ ok: true, body: { rateLimitUntil: 9999999999999 } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        // Non-string rateLimitUntil is ignored; peer is available
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("treats peer as unavailable when endpoint returns ok:false regardless of body", async () => {
        const fetch = makeFetch({ ok: false, body: { rateLimitUntil: null } });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(false);
    });
});

describe("PeerAvailabilityCondition: condition string regex", () => {
    const fetch = makeFetch({ ok: true });

    it("matches valid condition string 'peer:<id>.available'", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });

    it("matches peerId containing dots and hyphens", async () => {
        const peer = { peerId: "nova.primary-1", apiStatusUrl: "http://nova/api/loop/status" };
        const condition = new PeerAvailabilityCondition([peer], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.primary-1.available")).toBe(true);
    });

    it("returns false for missing 'peer:' prefix", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("nova.available")).toBe(false);
    });

    it("returns false for missing '.available' suffix", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova")).toBe(false);
    });

    it("returns false for empty string", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("")).toBe(false);
    });

    it("returns false for wrong suffix 'peer:nova.online'", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.online")).toBe(false);
    });

    it("returns false for empty peerId 'peer:.available'", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:.available")).toBe(false);
    });

    it("returns false for prefix-only 'peer:' with no suffix", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:")).toBe(false);
    });

    it("returns false for trailing garbage after '.available'", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);
        expect(await condition.evaluate("peer:nova.available.extra")).toBe(false);
    });
});

describe("PeerAvailabilityCondition: unknown-peer handling", () => {
    it("returns false when condition references a peer not in the config", async () => {
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), makeFetch({ ok: true }));
        expect(await condition.evaluate("peer:bishop.available")).toBe(false);
    });

    it("returns false for unknown peer even when network fetch would succeed", async () => {
        const condition = new PeerAvailabilityCondition([], makeLogger(), makeFetch({ ok: true }));
        expect(await condition.evaluate("peer:nova.available")).toBe(false);
    });

    it("does not affect state tracking for other known peers", async () => {
        let novaOk = false;
        const fetch = async (_url: string) => ({
            ok: true,
            json: async () => ({ rateLimitUntil: novaOk ? null : "2099-01-01T00:00:00Z" }),
        });
        const condition = new PeerAvailabilityCondition([PEER_NOVA], makeLogger(), fetch);

        // Unknown peer lookup — should not mutate state
        await condition.evaluate("peer:bishop.available");

        // Nova comes online — should still fire (lastAvailable[nova] is still undefined/false)
        novaOk = true;
        expect(await condition.evaluate("peer:nova.available")).toBe(true);
    });
});
