import { LoopWatchdog } from "../../src/loop/LoopWatchdog";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";

describe("LoopWatchdog", () => {
  const baseTime = new Date("2026-02-15T10:00:00Z");

  function createWatchdog(opts?: { stallThresholdMs?: number }) {
    const clock = new FixedClock(baseTime);
    const logger = new InMemoryLogger();
    const injected: string[] = [];
    const injectMessage = (msg: string) => { injected.push(msg); };

    const watchdog = new LoopWatchdog({
      clock,
      logger,
      injectMessage,
      stallThresholdMs: opts?.stallThresholdMs ?? 20 * 60 * 1000,
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
});
