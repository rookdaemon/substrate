import { LoopWatchdog } from "../../src/loop/LoopWatchdog";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";

describe("LoopWatchdog", () => {
  const baseTime = new Date("2026-02-15T10:00:00Z");

  function createWatchdog(opts?: { stallThresholdMs?: number; forceRestartThresholdMs?: number; forceRestart?: () => void }) {
    const clock = new FixedClock(baseTime);
    const logger = new InMemoryLogger();
    const injected: string[] = [];
    const injectMessage = (msg: string) => { injected.push(msg); };

    const watchdog = new LoopWatchdog({
      clock,
      logger,
      injectMessage,
      stallThresholdMs: opts?.stallThresholdMs ?? 20 * 60 * 1000,
      forceRestart: opts?.forceRestart,
      forceRestartThresholdMs: opts?.forceRestartThresholdMs,
    });

    return { watchdog, clock, logger, injected };
  }

  it("does not inject when activity is recent", () => {
    const { watchdog, injected } = createWatchdog();

    watchdog.recordActivity();
    watchdog.check();

    expect(injected).toHaveLength(0);
  });

  it("injects a reminder when stall threshold is exceeded", () => {
    const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 1000 });

    watchdog.recordActivity();

    // Advance past threshold
    clock.setNow(new Date(baseTime.getTime() + 2000));
    watchdog.check();

    expect(injected).toHaveLength(1);
    expect(injected[0]).toContain("gentle reminder");
  });

  it("does not inject again until new activity is recorded", () => {
    const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 1000 });

    watchdog.recordActivity();
    clock.setNow(new Date(baseTime.getTime() + 2000));
    watchdog.check();
    expect(injected).toHaveLength(1);

    // Check again without new activity — should not inject again
    clock.setNow(new Date(baseTime.getTime() + 4000));
    watchdog.check();
    expect(injected).toHaveLength(1);
  });

  it("injects again after new activity followed by another stall", () => {
    const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 1000 });

    watchdog.recordActivity();
    clock.setNow(new Date(baseTime.getTime() + 2000));
    watchdog.check();
    expect(injected).toHaveLength(1);

    // New activity resets the watchdog
    clock.setNow(new Date(baseTime.getTime() + 3000));
    watchdog.recordActivity();

    // Stall again
    clock.setNow(new Date(baseTime.getTime() + 5000));
    watchdog.check();
    expect(injected).toHaveLength(2);
  });

  it("does not inject when no activity has ever been recorded", () => {
    const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 1000 });

    // No recordActivity called — watchdog shouldn't assume a stall
    clock.setNow(new Date(baseTime.getTime() + 2000));
    watchdog.check();

    expect(injected).toHaveLength(0);
  });

  it("logs when injecting a reminder", () => {
    const { watchdog, clock, logger } = createWatchdog({ stallThresholdMs: 1000 });

    watchdog.recordActivity();
    clock.setNow(new Date(baseTime.getTime() + 2000));
    watchdog.check();

    expect(logger.getEntries().some(e => e.includes("watchdog"))).toBe(true);
  });

  it("reminder message references drives and goals", () => {
    const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 1000 });

    watchdog.recordActivity();
    clock.setNow(new Date(baseTime.getTime() + 2000));
    watchdog.check();

    const msg = injected[0];
    expect(msg).toContain("PLAN");
    expect(msg).toContain("VALUES");
  });

  it("start and stop manage the check interval", () => {
    const { watchdog } = createWatchdog();

    watchdog.start(5000);
    expect(watchdog.isRunning()).toBe(true);

    watchdog.stop();
    expect(watchdog.isRunning()).toBe(false);
  });

  it("stop is safe to call when not running", () => {
    const { watchdog } = createWatchdog();

    expect(() => watchdog.stop()).not.toThrow();
  });

  it("injects at custom stall threshold", () => {
    const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 5 * 60 * 1000 });

    watchdog.recordActivity();

    // Advance to just under threshold — should not inject
    clock.setNow(new Date(baseTime.getTime() + 4 * 60 * 1000 + 59 * 1000));
    watchdog.check();
    expect(injected).toHaveLength(0);

    // Advance past threshold — should inject
    clock.setNow(new Date(baseTime.getTime() + 5 * 60 * 1000 + 1000));
    watchdog.check();
    expect(injected).toHaveLength(1);
  });

  describe("sleep-awareness: pause/resume", () => {
    it("check() is a no-op when paused", () => {
      const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 1000 });

      watchdog.recordActivity();
      watchdog.pause();

      // Advance past stall threshold — should not inject because paused
      clock.setNow(new Date(baseTime.getTime() + 2000));
      watchdog.check();

      expect(injected).toHaveLength(0);
    });

    it("check() fires again after resume()", () => {
      const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 1000 });

      watchdog.recordActivity();
      watchdog.pause();

      // While paused, no injection even if threshold exceeded
      clock.setNow(new Date(baseTime.getTime() + 2000));
      watchdog.check();
      expect(injected).toHaveLength(0);

      // Resume resets the activity clock — stall timer restarts
      watchdog.resume();
      // Still within threshold from resume time
      watchdog.check();
      expect(injected).toHaveLength(0);

      // Advance past threshold again from the resume point
      clock.setNow(new Date(baseTime.getTime() + 4000));
      watchdog.check();
      expect(injected).toHaveLength(1);
    });

    it("forceRestart is not called while paused", () => {
      let restartCalled = false;
      const { watchdog, clock } = createWatchdog({
        stallThresholdMs: 1000,
        forceRestartThresholdMs: 500,
        forceRestart: () => { restartCalled = true; },
      });

      watchdog.recordActivity();
      watchdog.pause();

      clock.setNow(new Date(baseTime.getTime() + 5000));
      watchdog.check();

      expect(restartCalled).toBe(false);
    });

    it("resume() resets activity time so stall starts fresh", () => {
      const { watchdog, clock, injected } = createWatchdog({ stallThresholdMs: 2000 });

      watchdog.recordActivity();
      watchdog.pause();

      // Long time passes while sleeping
      clock.setNow(new Date(baseTime.getTime() + 10000));
      watchdog.resume();

      // Just after resume — within threshold from resume time
      clock.setNow(new Date(baseTime.getTime() + 11000));
      watchdog.check();
      expect(injected).toHaveLength(0);

      // Past threshold from resume time
      clock.setNow(new Date(baseTime.getTime() + 13000));
      watchdog.check();
      expect(injected).toHaveLength(1);
    });

    it("logs when paused and resumed", () => {
      const { watchdog, logger } = createWatchdog();

      watchdog.pause();
      expect(logger.getEntries().some(e => e.includes("paused"))).toBe(true);

      watchdog.resume();
      expect(logger.getEntries().some(e => e.includes("resumed"))).toBe(true);
    });
  });

  describe("force restart behavior", () => {
    it("calls forceRestart after forceRestartThresholdMs following a stall reminder", () => {
      let restartCalled = false;
      const { watchdog, clock } = createWatchdog({
        stallThresholdMs: 1000,
        forceRestartThresholdMs: 500,
        forceRestart: () => { restartCalled = true; },
      });

      watchdog.recordActivity();

      // Advance past stall threshold — should inject reminder
      clock.setNow(new Date(baseTime.getTime() + 2000));
      watchdog.check();
      expect(restartCalled).toBe(false); // Reminder injected, no restart yet

      // Advance past forceRestart threshold after reminder
      clock.setNow(new Date(baseTime.getTime() + 2600));
      watchdog.check();
      expect(restartCalled).toBe(true);
    });

    it("does not call forceRestart before forceRestartThresholdMs has elapsed", () => {
      let restartCalled = false;
      const { watchdog, clock } = createWatchdog({
        stallThresholdMs: 1000,
        forceRestartThresholdMs: 5000,
        forceRestart: () => { restartCalled = true; },
      });

      watchdog.recordActivity();

      // Advance past stall threshold
      clock.setNow(new Date(baseTime.getTime() + 2000));
      watchdog.check();
      expect(restartCalled).toBe(false);

      // Advance, but not past forceRestart threshold
      clock.setNow(new Date(baseTime.getTime() + 4000));
      watchdog.check();
      expect(restartCalled).toBe(false);
    });

    it("does not call forceRestart when forceRestart callback is not set", () => {
      // Should not throw even when stall persists past forceRestartThresholdMs
      const { watchdog, clock, injected } = createWatchdog({
        stallThresholdMs: 1000,
        forceRestartThresholdMs: 500,
        // forceRestart not set
      });

      watchdog.recordActivity();
      clock.setNow(new Date(baseTime.getTime() + 3000));
      watchdog.check();
      // Only the reminder should be injected, no error
      expect(injected).toHaveLength(1);
    });

    it("does not call forceRestart when forceRestartThresholdMs is 0", () => {
      let restartCalled = false;
      const { watchdog, clock } = createWatchdog({
        stallThresholdMs: 1000,
        forceRestartThresholdMs: 0,
        forceRestart: () => { restartCalled = true; },
      });

      watchdog.recordActivity();
      clock.setNow(new Date(baseTime.getTime() + 5000));
      watchdog.check();
      expect(restartCalled).toBe(false);
    });

    it("logs when force-restarting", () => {
      const { watchdog, clock, logger } = createWatchdog({
        stallThresholdMs: 1000,
        forceRestartThresholdMs: 500,
        forceRestart: () => {},
      });

      watchdog.recordActivity();
      clock.setNow(new Date(baseTime.getTime() + 2000));
      watchdog.check(); // reminder
      clock.setNow(new Date(baseTime.getTime() + 2600));
      watchdog.check(); // force restart

      expect(logger.getEntries().some(e => e.includes("force restart"))).toBe(true);
    });

    it("resets force-restart state when new activity is recorded after stall", () => {
      let restartCount = 0;
      const { watchdog, clock } = createWatchdog({
        stallThresholdMs: 1000,
        forceRestartThresholdMs: 500,
        forceRestart: () => { restartCount++; },
      });

      // First stall cycle — reminder then restart
      watchdog.recordActivity();
      clock.setNow(new Date(baseTime.getTime() + 2000));
      watchdog.check(); // reminder
      clock.setNow(new Date(baseTime.getTime() + 2600));
      watchdog.check(); // force restart
      expect(restartCount).toBe(1);

      // New activity resets state
      watchdog.recordActivity();
      clock.setNow(new Date(baseTime.getTime() + 4000));
      watchdog.check(); // still within threshold from new activity
      expect(restartCount).toBe(1); // No additional restart
    });
  });
});
