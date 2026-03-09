import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PeerRateLimitStore } from "../../src/agora/PeerRateLimitStore";
import type { IClock } from "../../src/substrate/abstractions/IClock";

class MockClock implements IClock {
  constructor(private currentTime: Date) {}
  now(): Date { return this.currentTime; }
  advance(ms: number): void { this.currentTime = new Date(this.currentTime.getTime() + ms); }
}

describe("PeerRateLimitStore", () => {
  let tmpDir: string;
  let filePath: string;
  let clock: MockClock;

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "peer-rl-store-"));
    filePath = join(tmpDir, ".peer-rate-limit-state");
    clock = new MockClock(new Date("2026-03-09T10:00:00Z"));
  });

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true });
  });

  describe("record and getActive", () => {
    it("returns empty list when no peers recorded", () => {
      const store = new PeerRateLimitStore(filePath, clock);
      expect(store.getActive()).toEqual([]);
    });

    it("returns a peer whose rate limit is in the future", () => {
      const store = new PeerRateLimitStore(filePath, clock);
      const future = new Date("2026-03-09T11:00:00Z");
      store.record("bishop@67893eb4", future);

      const active = store.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].identity).toBe("bishop@67893eb4");
      expect(active[0].rateLimitUntil).toBe(future.toISOString());
      expect(active[0].notedAt).toBe(clock.now().toISOString());
    });

    it("excludes a peer whose rate limit has already expired", () => {
      const store = new PeerRateLimitStore(filePath, clock);
      const past = new Date("2026-03-09T09:00:00Z"); // before clock.now()
      store.record("bishop@67893eb4", past);

      expect(store.getActive()).toHaveLength(0);
    });

    it("overwrites the rate limit if the same peer is recorded again", () => {
      const store = new PeerRateLimitStore(filePath, clock);
      store.record("bishop@67893eb4", new Date("2026-03-09T11:00:00Z"));
      clock.advance(60_000); // 1 minute later
      const updated = new Date("2026-03-09T12:00:00Z");
      store.record("bishop@67893eb4", updated);

      const active = store.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].rateLimitUntil).toBe(updated.toISOString());
      expect(active[0].notedAt).toBe(clock.now().toISOString());
    });

    it("tracks multiple peers independently", () => {
      const store = new PeerRateLimitStore(filePath, clock);
      store.record("bishop@67893eb4", new Date("2026-03-09T11:00:00Z"));
      store.record("rook@11251b69", new Date("2026-03-09T10:30:00Z"));

      const active = store.getActive();
      expect(active).toHaveLength(2);
      const identities = active.map((r) => r.identity).sort();
      expect(identities).toEqual(["bishop@67893eb4", "rook@11251b69"]);
    });

    it("only returns peers that are still active when some have expired", () => {
      const store = new PeerRateLimitStore(filePath, clock);
      store.record("bishop@67893eb4", new Date("2026-03-09T11:00:00Z")); // future
      store.record("rook@11251b69", new Date("2026-03-09T09:59:00Z")); // past

      const active = store.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].identity).toBe("bishop@67893eb4");
    });
  });

  describe("save and load", () => {
    it("persists and restores active records across instances", async () => {
      const store = new PeerRateLimitStore(filePath, clock);
      store.record("bishop@67893eb4", new Date("2026-03-09T11:00:00Z"));
      await store.save();

      const store2 = new PeerRateLimitStore(filePath, clock);
      await store2.load();
      const active = store2.getActive();
      expect(active).toHaveLength(1);
      expect(active[0].identity).toBe("bishop@67893eb4");
    });

    it("load from missing file starts fresh without error", async () => {
      const store = new PeerRateLimitStore("/nonexistent/.peer-rate-limit-state", clock);
      await expect(store.load()).resolves.not.toThrow();
      expect(store.getActive()).toEqual([]);
    });

    it("save then load round-trips all record fields", async () => {
      const store = new PeerRateLimitStore(filePath, clock);
      const until = new Date("2026-03-09T11:00:00Z");
      store.record("bishop@67893eb4", until);
      await store.save();

      const store2 = new PeerRateLimitStore(filePath, clock);
      await store2.load();
      const active = store2.getActive();
      expect(active[0].rateLimitUntil).toBe(until.toISOString());
      expect(active[0].notedAt).toBe(clock.now().toISOString());
    });

    it("expired entries loaded from disk are not returned as active", async () => {
      const store = new PeerRateLimitStore(filePath, clock);
      store.record("bishop@67893eb4", new Date("2026-03-09T09:00:00Z")); // already past
      await store.save();

      const store2 = new PeerRateLimitStore(filePath, clock);
      await store2.load();
      expect(store2.getActive()).toHaveLength(0);
    });
  });
});
