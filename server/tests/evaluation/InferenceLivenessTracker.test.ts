import { InferenceLivenessTracker } from "../../src/evaluation/InferenceLivenessTracker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("InferenceLivenessTracker", () => {
  let clock: FixedClock;
  let tracker: InferenceLivenessTracker;

  beforeEach(() => {
    clock = new FixedClock(new Date("2026-06-12T10:00:00.000Z"));
    tracker = new InferenceLivenessTracker(clock);
  });

  it("starts fail-closed until an inference attempt is observed", () => {
    const state = tracker.getState();
    expect(state.observed).toBe(false);
    expect(state.alive).toBe(false);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeUndefined();
    expect(state.lastSuccessAt).toBeNull();
    expect(state.lastFailureAt).toBeNull();
    expect(tracker.isHealthy()).toBe(false);
  });

  it("records a success", () => {
    tracker.recordSuccess();
    const state = tracker.getState();
    expect(state.observed).toBe(true);
    expect(state.alive).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastSuccessAt).toEqual(new Date("2026-06-12T10:00:00.000Z"));
  });

  it("increments consecutiveFailures on each failure", () => {
    tracker.recordFailure("HTTP 401: unauthorized");
    expect(tracker.getState().consecutiveFailures).toBe(1);
    tracker.recordFailure("HTTP 401: unauthorized");
    expect(tracker.getState().consecutiveFailures).toBe(2);
    tracker.recordFailure("HTTP 401: unauthorized");
    expect(tracker.getState().consecutiveFailures).toBe(3);
  });

  it("captures the last error message", () => {
    tracker.recordFailure("auth failed");
    expect(tracker.getState().lastError).toBe("auth failed");
    tracker.recordFailure("rate limit");
    expect(tracker.getState().lastError).toBe("rate limit");
  });

  it("resets consecutiveFailures to zero after a success", () => {
    tracker.recordFailure("HTTP 401");
    tracker.recordFailure("HTTP 401");
    expect(tracker.getState().consecutiveFailures).toBe(2);

    tracker.recordSuccess();
    const state = tracker.getState();
    expect(state.consecutiveFailures).toBe(0);
    expect(state.alive).toBe(true);
    expect(state.lastError).toBeUndefined();
  });

  it("isHealthy uses threshold of 3 by default", () => {
    tracker.recordFailure("err");
    tracker.recordFailure("err");
    expect(tracker.isHealthy()).toBe(true); // 2 < 3

    tracker.recordFailure("err");
    expect(tracker.isHealthy()).toBe(false); // 3 >= 3
  });

  it("isHealthy respects custom threshold", () => {
    tracker.recordFailure("err");
    expect(tracker.isHealthy(1)).toBe(false); // 1 >= 1
    expect(tracker.isHealthy(2)).toBe(true);  // 1 < 2
  });

  it("alive is false when consecutiveFailures > 0", () => {
    tracker.recordFailure("err");
    expect(tracker.getState().alive).toBe(false);
  });

  it("records lastFailureAt timestamp", () => {
    tracker.recordFailure("err");
    expect(tracker.getState().lastFailureAt).toEqual(new Date("2026-06-12T10:00:00.000Z"));
  });

  it("works without a clock (uses real Date)", () => {
    const noClockTracker = new InferenceLivenessTracker();
    noClockTracker.recordSuccess();
    expect(noClockTracker.getState().lastSuccessAt).toBeInstanceOf(Date);
  });

  it("persists failures and reloads them after restart", async () => {
    const fs = new InMemoryFileSystem();
    const statePath = "/state/inference-liveness.json";
    const first = new InferenceLivenessTracker(clock, { fs, statePath });

    first.recordFailure("HTTP 401");
    first.recordFailure("HTTP 401");
    first.recordFailure("HTTP 401");
    await first.flush();

    const reloaded = await InferenceLivenessTracker.load(clock, { fs, statePath });
    const state = reloaded.getState();

    expect(state.observed).toBe(true);
    expect(state.alive).toBe(false);
    expect(state.consecutiveFailures).toBe(3);
    expect(state.lastError).toBe("HTTP 401");
    expect(reloaded.isHealthy()).toBe(false);
  });

  it("reloads a persisted success as healthy", async () => {
    const fs = new InMemoryFileSystem();
    const statePath = "/state/inference-liveness.json";
    const first = new InferenceLivenessTracker(clock, { fs, statePath });

    first.recordSuccess();
    await first.flush();

    const reloaded = await InferenceLivenessTracker.load(clock, { fs, statePath });

    expect(reloaded.getState()).toEqual(expect.objectContaining({
      observed: true,
      alive: true,
      consecutiveFailures: 0,
    }));
    expect(reloaded.isHealthy()).toBe(true);
  });

  describe("getHealthStatus", () => {
    it("reports unknown before any inference attempt without weakening fail-closed isHealthy", () => {
      expect(tracker.getState()).toEqual(expect.objectContaining({
        observed: false,
        alive: false,
        consecutiveFailures: 0,
      }));
      expect(tracker.isHealthy()).toBe(false);
      expect(tracker.getHealthStatus()).toBe("unknown");
    });

    it("reports 'healthy' after a success", () => {
      tracker.recordSuccess();
      expect(tracker.getHealthStatus()).toBe("healthy");
    });

    it("reports 'unknown' (not 'degraded') for 1-2 failures with no prior success", () => {
      tracker.recordFailure("err");
      expect(tracker.getHealthStatus()).toBe("unknown");
      tracker.recordFailure("err");
      expect(tracker.getHealthStatus()).toBe("unknown");
    });

    it("reports 'degraded' at >= maxConsecutiveFailures", () => {
      tracker.recordFailure("err");
      tracker.recordFailure("err");
      tracker.recordFailure("err");
      expect(tracker.getHealthStatus()).toBe("degraded");
    });

    it("respects a custom maxConsecutiveFailures threshold", () => {
      tracker.recordFailure("err");
      expect(tracker.getHealthStatus(1)).toBe("degraded"); // 1 >= 1
      expect(tracker.getHealthStatus(2)).toBe("unknown"); // 1 < 2, never succeeded
    });

    it("degraded takes precedence over staleness/never-probed", () => {
      tracker.recordFailure("err");
      tracker.recordFailure("err");
      tracker.recordFailure("err");
      // never succeeded AND failing: failure escalation wins
      expect(tracker.getHealthStatus(3, 1000)).toBe("degraded");
    });

    it("does not age out when maxStalenessMs is omitted", () => {
      tracker.recordSuccess();
      clock.advance(365 * 24 * 60 * 60 * 1000); // a year later
      expect(tracker.getHealthStatus()).toBe("healthy");
    });

    it("reports 'healthy' within the staleness window", () => {
      tracker.recordSuccess();
      clock.advance(30 * 1000); // 30s later
      expect(tracker.getHealthStatus(3, 60 * 1000)).toBe("healthy");
    });

    it("reports 'unknown' (stale) once last success exceeds maxStalenessMs", () => {
      tracker.recordSuccess();
      clock.advance(2 * 60 * 1000); // 2 min later
      expect(tracker.getHealthStatus(3, 60 * 1000)).toBe("unknown");
    });

    it("a fresh success clears a prior stale state", () => {
      tracker.recordSuccess();
      clock.advance(2 * 60 * 1000);
      expect(tracker.getHealthStatus(3, 60 * 1000)).toBe("unknown");
      tracker.recordSuccess(); // now at clock = +2min
      expect(tracker.getHealthStatus(3, 60 * 1000)).toBe("healthy");
    });

    it("reloads persisted failures as degraded", async () => {
      const fs = new InMemoryFileSystem();
      const statePath = "/state/inference-liveness.json";
      const first = new InferenceLivenessTracker(clock, { fs, statePath });

      first.recordFailure("HTTP 401");
      first.recordFailure("HTTP 401");
      first.recordFailure("HTTP 401");
      await first.flush();

      const reloaded = await InferenceLivenessTracker.load(clock, { fs, statePath });

      expect(reloaded.getHealthStatus()).toBe("degraded");
    });
  });
});
