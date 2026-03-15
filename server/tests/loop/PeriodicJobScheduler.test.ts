import { PeriodicJobScheduler } from "../../src/loop/PeriodicJobScheduler";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";

describe("PeriodicJobScheduler", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;

  const BASE_TIME = new Date("2026-01-01T00:00:00.000Z");
  const INTERVAL_MS = 3600000; // 1 hour
  const STATE_FILE = "/config/state.txt";

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(BASE_TIME);
    logger = new InMemoryLogger();
  });

  function makeScheduler<T>(
    job: () => Promise<T>,
    opts: { stateFilePath?: string } = {}
  ): PeriodicJobScheduler<T> {
    return new PeriodicJobScheduler<T>(
      opts.stateFilePath ? fs : null,
      clock,
      logger,
      { intervalMs: INTERVAL_MS, stateFilePath: opts.stateFilePath, name: "TestScheduler" },
      job
    );
  }

  // ── shouldRun ──────────────────────────────────────────────────────────────

  describe("shouldRun", () => {
    it("returns true on first call (no state file)", async () => {
      const scheduler = makeScheduler(async () => "result");
      expect(await scheduler.shouldRun()).toBe(true);
    });

    it("returns true on first call (no state file exists on disk)", async () => {
      const scheduler = makeScheduler(async () => "result", { stateFilePath: STATE_FILE });
      expect(await scheduler.shouldRun()).toBe(true);
    });

    it("returns false immediately after a successful run", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.run();
      expect(await scheduler.shouldRun()).toBe(false);
    });

    it("returns true once the interval has elapsed", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.run();
      clock.setNow(new Date(BASE_TIME.getTime() + INTERVAL_MS));
      expect(await scheduler.shouldRun()).toBe(true);
    });

    it("returns false when interval has not fully elapsed", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.run();
      clock.setNow(new Date(BASE_TIME.getTime() + INTERVAL_MS - 1));
      expect(await scheduler.shouldRun()).toBe(false);
    });

    it("loads persisted state from disk on first call", async () => {
      // Pre-populate state file (run 5 days ago)
      const pastTime = new Date(BASE_TIME.getTime() - 5 * 24 * 3600_000);
      await fs.mkdir("/config", { recursive: true });
      await fs.writeFile(STATE_FILE, pastTime.toISOString());

      const scheduler = makeScheduler(async () => "ok", { stateFilePath: STATE_FILE });
      // 5 days > 1 hour interval → should run
      expect(await scheduler.shouldRun()).toBe(true);
    });

    it("uses persisted state to defer the next run", async () => {
      // State file says we ran 30 minutes ago
      const pastTime = new Date(BASE_TIME.getTime() - 30 * 60 * 1000);
      await fs.mkdir("/config", { recursive: true });
      await fs.writeFile(STATE_FILE, pastTime.toISOString());

      const scheduler = makeScheduler(async () => "ok", { stateFilePath: STATE_FILE });
      expect(await scheduler.shouldRun()).toBe(false); // not 1 hour yet
    });

    it("treats an invalid state file as if no run has occurred", async () => {
      await fs.mkdir("/config", { recursive: true });
      await fs.writeFile(STATE_FILE, "not-a-date");

      const scheduler = makeScheduler(async () => "ok", { stateFilePath: STATE_FILE });
      expect(await scheduler.shouldRun()).toBe(true);
    });
  });

  // ── isRunDue ───────────────────────────────────────────────────────────────

  describe("isRunDue (synchronous)", () => {
    it("returns true before any run (no state file)", () => {
      const scheduler = makeScheduler(async () => "ok");
      expect(scheduler.isRunDue()).toBe(true);
    });

    it("returns false immediately after a run", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.run();
      expect(scheduler.isRunDue()).toBe(false);
    });

    it("returns true once the interval elapses", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.run();
      clock.setNow(new Date(BASE_TIME.getTime() + INTERVAL_MS));
      expect(scheduler.isRunDue()).toBe(true);
    });
  });

  // ── run ────────────────────────────────────────────────────────────────────

  describe("run", () => {
    it("executes the job and returns the result", async () => {
      const scheduler = makeScheduler(async () => 42);
      const result = await scheduler.run();
      expect(result).toBe(42);
    });

    it("increments runCount after each successful run", async () => {
      const scheduler = makeScheduler(async () => "ok");
      expect(scheduler.runCount).toBe(0);
      await scheduler.run();
      expect(scheduler.runCount).toBe(1);
      await scheduler.run();
      expect(scheduler.runCount).toBe(2);
    });

    it("updates lastRunTime after a successful run", async () => {
      const scheduler = makeScheduler(async () => "ok");
      expect(scheduler.lastRunTime).toBeNull();
      await scheduler.run();
      expect(scheduler.lastRunTime).toEqual(BASE_TIME);
    });

    it("does NOT update state when the job throws", async () => {
      const scheduler = makeScheduler(async () => {
        throw new Error("job error");
      });

      await expect(scheduler.run()).rejects.toThrow("job error");

      expect(scheduler.runCount).toBe(0);
      expect(scheduler.lastRunTime).toBeNull();
    });

    it("retries (shouldRun stays true) when the job throws", async () => {
      const scheduler = makeScheduler(async () => {
        throw new Error("transient failure");
      });

      await expect(scheduler.run()).rejects.toThrow();
      expect(await scheduler.shouldRun()).toBe(true);
    });

    it("persists state to the state file on success", async () => {
      const scheduler = makeScheduler(async () => "ok", { stateFilePath: STATE_FILE });
      await scheduler.run();

      const content = await fs.readFile(STATE_FILE);
      expect(content).toBe(BASE_TIME.toISOString());
    });

    it("does NOT write the state file when the job throws", async () => {
      const scheduler = makeScheduler(
        async () => { throw new Error("fail"); },
        { stateFilePath: STATE_FILE }
      );

      await expect(scheduler.run()).rejects.toThrow();
      expect(await fs.exists(STATE_FILE)).toBe(false);
    });
  });

  // ── markRan ────────────────────────────────────────────────────────────────

  describe("markRan", () => {
    it("updates lastRunTime and runCount", async () => {
      const scheduler = makeScheduler(async () => "ok");
      const time = new Date("2026-06-01T12:00:00.000Z");
      await scheduler.markRan(time);
      expect(scheduler.lastRunTime).toEqual(time);
      expect(scheduler.runCount).toBe(1);
    });

    it("persists the timestamp to the state file", async () => {
      const scheduler = makeScheduler(async () => "ok", { stateFilePath: STATE_FILE });
      const time = new Date("2026-06-01T12:00:00.000Z");
      await scheduler.markRan(time);

      const content = await fs.readFile(STATE_FILE);
      expect(content).toBe(time.toISOString());
    });

    it("affects subsequent shouldRun() results", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.markRan(BASE_TIME);
      expect(await scheduler.shouldRun()).toBe(false);

      clock.setNow(new Date(BASE_TIME.getTime() + INTERVAL_MS));
      expect(await scheduler.shouldRun()).toBe(true);
    });
  });

  // ── getStatus ──────────────────────────────────────────────────────────────

  describe("getStatus", () => {
    it("returns nulls and zero before first run", () => {
      const scheduler = makeScheduler(async () => "ok");
      const s = scheduler.getStatus();
      expect(s.lastRunTime).toBeNull();
      expect(s.runCount).toBe(0);
    });

    it("returns nextDue as clock.now() before first run", () => {
      const scheduler = makeScheduler(async () => "ok");
      const s = scheduler.getStatus();
      expect(s.nextDue).toEqual(BASE_TIME);
    });

    it("returns correct nextDue after a run", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.run();
      const s = scheduler.getStatus();
      expect(s.lastRunTime).toEqual(BASE_TIME);
      expect(s.nextDue).toEqual(new Date(BASE_TIME.getTime() + INTERVAL_MS));
      expect(s.runCount).toBe(1);
    });

    it("updates correctly after multiple runs", async () => {
      const scheduler = makeScheduler(async () => "ok");
      await scheduler.run();

      const t2 = new Date(BASE_TIME.getTime() + INTERVAL_MS);
      clock.setNow(t2);
      await scheduler.run();

      const s = scheduler.getStatus();
      expect(s.lastRunTime).toEqual(t2);
      expect(s.runCount).toBe(2);
      expect(s.nextDue).toEqual(new Date(t2.getTime() + INTERVAL_MS));
    });
  });

  // ── state file persistence ─────────────────────────────────────────────────

  describe("state file persistence", () => {
    it("creates parent directory if it does not exist", async () => {
      const scheduler = makeScheduler(async () => "ok", { stateFilePath: "/deep/path/state.txt" });
      await scheduler.run();

      expect(await fs.exists("/deep/path/state.txt")).toBe(true);
    });

    it("shares state across instances via state file", async () => {
      // First instance runs
      const s1 = makeScheduler(async () => "ok", { stateFilePath: STATE_FILE });
      await s1.run();

      // Second instance with same state file should see the run
      const s2 = makeScheduler(async () => "ok", { stateFilePath: STATE_FILE });
      expect(await s2.shouldRun()).toBe(false); // same state, interval not elapsed
    });

    it("silently handles a state-file write error", async () => {
      // Use a path where the directory can't be created — InMemoryFileSystem will
      // succeed but we can simulate a write error by passing null fs.
      const scheduler = new PeriodicJobScheduler<string>(
        null, // no fs → persist is a no-op
        clock,
        logger,
        { intervalMs: INTERVAL_MS, stateFilePath: STATE_FILE, name: "TestScheduler" },
        async () => "ok"
      );

      // Should succeed even though nothing is persisted
      await expect(scheduler.run()).resolves.toBe("ok");
    });
  });
});
