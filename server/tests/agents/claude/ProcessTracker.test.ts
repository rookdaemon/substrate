import { ProcessTracker, ProcessKiller, ProcessTrackerConfig } from "../../../src/agents/claude/ProcessTracker";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../../src/logging";

class MockProcessKiller implements ProcessKiller {
  private alivePids = new Set<number>();
  private killCalls: Array<{ pid: number; signal: string }> = [];

  setAlive(pid: number, alive: boolean): void {
    if (alive) {
      this.alivePids.add(pid);
    } else {
      this.alivePids.delete(pid);
    }
  }

  isProcessAlive(pid: number): boolean {
    return this.alivePids.has(pid);
  }

  killProcess(pid: number, signal: string): void {
    this.killCalls.push({ pid, signal });
    this.alivePids.delete(pid); // Assume kill succeeds
  }

  getKillCalls(): Array<{ pid: number; signal: string }> {
    return [...this.killCalls];
  }

  clearKillCalls(): void {
    this.killCalls = [];
  }
}

describe("ProcessTracker", () => {
  const baseDate = new Date("2025-06-15T10:00:00Z");
  let clock: FixedClock;
  let killer: MockProcessKiller;
  let logger: InMemoryLogger;
  let tracker: ProcessTracker;

  beforeEach(() => {
    clock = new FixedClock(baseDate);
    killer = new MockProcessKiller();
    logger = new InMemoryLogger();
    const config: ProcessTrackerConfig = {
      gracePeriodMs: 600_000, // 10 min
      reaperIntervalMs: 60_000, // 1 min
    };
    tracker = new ProcessTracker(clock, killer, config, logger);
  });

  it("registers PID on session start", () => {
    tracker.registerPid(12345);
    expect(tracker.getActivePids()).toContain(12345);
    expect(tracker.getAbandonedPids()).not.toContain(12345);
  });

  it("removes PID on process exit", () => {
    tracker.registerPid(12345);
    tracker.onProcessExit(12345);
    expect(tracker.getActivePids()).not.toContain(12345);
    expect(tracker.getAbandonedPids()).not.toContain(12345);
  });

  it("moves PID to abandoned list when abandoned", () => {
    tracker.registerPid(12345);
    killer.setAlive(12345, true);
    tracker.abandonPid(12345);
    expect(tracker.getActivePids()).not.toContain(12345);
    expect(tracker.getAbandonedPids()).toContain(12345);
  });

  it("kills abandoned PID after grace period when still running", () => {
    tracker.registerPid(12345);
    killer.setAlive(12345, true);
    tracker.abandonPid(12345);

    // Advance clock past grace period
    clock.setNow(new Date(baseDate.getTime() + 601_000)); // 10 min + 1 sec

    // Trigger reaper manually (normally done by interval)
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tracker as any).reap();

    const killCalls = killer.getKillCalls();
    expect(killCalls.length).toBeGreaterThan(0);
    expect(killCalls[0].pid).toBe(12345);
    expect(killCalls[0].signal).toBe("SIGTERM");
  });

  it("does not kill abandoned PID if already exited", () => {
    tracker.registerPid(12345);
    killer.setAlive(12345, false); // Process already dead
    tracker.abandonPid(12345);

    // Advance clock past grace period
    clock.setNow(new Date(baseDate.getTime() + 601_000));

    killer.clearKillCalls();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tracker as any).reap();

    const killCalls = killer.getKillCalls();
    expect(killCalls.length).toBe(0);
  });

  it("does not kill abandoned PID before grace period", () => {
    tracker.registerPid(12345);
    killer.setAlive(12345, true);
    tracker.abandonPid(12345);

    // Advance clock but not past grace period
    clock.setNow(new Date(baseDate.getTime() + 300_000)); // 5 min

    killer.clearKillCalls();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tracker as any).reap();

    const killCalls = killer.getKillCalls();
    expect(killCalls.length).toBe(0);
  });

  it("removes PID from abandoned list after killing", () => {
    tracker.registerPid(12345);
    killer.setAlive(12345, true);
    tracker.abandonPid(12345);

    // Advance clock past grace period
    clock.setNow(new Date(baseDate.getTime() + 601_000));

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tracker as any).reap();

    // PID should be removed from abandoned list after kill
    expect(tracker.getAbandonedPids()).not.toContain(12345);
  });

  it("handles multiple abandoned PIDs", () => {
    tracker.registerPid(111);
    tracker.registerPid(222);
    tracker.registerPid(333);

    killer.setAlive(111, true);
    killer.setAlive(222, false); // Already dead
    killer.setAlive(333, true);

    tracker.abandonPid(111);
    tracker.abandonPid(222);
    tracker.abandonPid(333);

    // Advance clock past grace period
    clock.setNow(new Date(baseDate.getTime() + 601_000));

    killer.clearKillCalls();
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tracker as any).reap();

    const killCalls = killer.getKillCalls();
    // Should kill 111 and 333 (still alive), but not 222 (already dead)
    expect(killCalls.length).toBe(2);
    expect(killCalls.map((c) => c.pid).sort()).toEqual([111, 333]);
  });

  it("stops reaper when no abandoned processes remain", () => {
    tracker.registerPid(12345);
    killer.setAlive(12345, true);
    tracker.abandonPid(12345);

    // Advance clock and reap
    clock.setNow(new Date(baseDate.getTime() + 601_000));
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (tracker as any).reap();

    // Reaper should stop (no abandoned processes left)
    expect(tracker.getAbandonedPids().length).toBe(0);
  });
});
