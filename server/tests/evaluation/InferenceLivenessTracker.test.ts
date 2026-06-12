import { InferenceLivenessTracker } from "../../src/evaluation/InferenceLivenessTracker";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("InferenceLivenessTracker", () => {
  let clock: FixedClock;
  let tracker: InferenceLivenessTracker;

  beforeEach(() => {
    clock = new FixedClock(new Date("2026-06-12T10:00:00.000Z"));
    tracker = new InferenceLivenessTracker(clock);
  });

  it("starts healthy with zero failures", () => {
    const state = tracker.getState();
    expect(state.alive).toBe(true);
    expect(state.consecutiveFailures).toBe(0);
    expect(state.lastError).toBeUndefined();
    expect(state.lastSuccessAt).toBeNull();
    expect(state.lastFailureAt).toBeNull();
    expect(tracker.isHealthy()).toBe(true);
  });

  it("records a success", () => {
    tracker.recordSuccess();
    const state = tracker.getState();
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
});
