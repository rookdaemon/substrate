import { OutputQualityMonitor } from "../../src/evaluation/OutputQualityMonitor";
import { EndorsementSessionStats } from "../../src/agents/endorsement/EndorsementInterceptor";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

function stats(overrides: Partial<EndorsementSessionStats> = {}): EndorsementSessionStats {
  return {
    totalChecks: 1,
    parseErrors: 0,
    placeholderActions: 0,
    ...overrides,
  };
}

describe("OutputQualityMonitor", () => {
  let clock: FixedClock;
  let monitor: OutputQualityMonitor;

  beforeEach(() => {
    clock = new FixedClock(new Date("2026-06-18T12:00:00.000Z"));
    monitor = new OutputQualityMonitor(clock);
  });

  it("starts healthy with zero degraded cycles", () => {
    const state = monitor.getState();
    expect(state.healthy).toBe(true);
    expect(state.consecutiveDegradedCycles).toBe(0);
    expect(state.lastDegradedReason).toBeUndefined();
    expect(state.lastHealthyAt).toBeNull();
    expect(state.lastDegradedAt).toBeNull();
    expect(monitor.isHealthy()).toBe(true);
  });

  describe("healthy cycle recording", () => {
    it("records a healthy cycle (no parse errors or placeholder actions)", () => {
      monitor.recordCycleStats(stats({ totalChecks: 1, parseErrors: 0, placeholderActions: 0 }));

      const state = monitor.getState();
      expect(state.healthy).toBe(true);
      expect(state.consecutiveDegradedCycles).toBe(0);
      expect(state.lastHealthyAt).toEqual(new Date("2026-06-18T12:00:00.000Z"));
      expect(state.lastDegradedAt).toBeNull();
    });

    it("resets consecutiveDegradedCycles to zero after a healthy cycle", () => {
      // Two degraded cycles
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      expect(monitor.getState().consecutiveDegradedCycles).toBe(2);

      // Then a healthy cycle
      monitor.recordCycleStats(stats({ parseErrors: 0 }));
      expect(monitor.getState().consecutiveDegradedCycles).toBe(0);
      expect(monitor.getState().healthy).toBe(true);
    });

    it("clears lastDegradedReason after a healthy cycle", () => {
      monitor.recordCycleStats(stats({ parseErrors: 2 }));
      expect(monitor.getState().lastDegradedReason).toBeDefined();

      monitor.recordCycleStats(stats({ parseErrors: 0 }));
      expect(monitor.getState().lastDegradedReason).toBeUndefined();
    });
  });

  describe("parse-error storm detection", () => {
    it("increments consecutiveDegradedCycles when parseErrors > 0", () => {
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      expect(monitor.getState().consecutiveDegradedCycles).toBe(1);

      monitor.recordCycleStats(stats({ parseErrors: 3 }));
      expect(monitor.getState().consecutiveDegradedCycles).toBe(2);
    });

    it("sets lastDegradedReason mentioning parse-error", () => {
      monitor.recordCycleStats(stats({ parseErrors: 2, totalChecks: 3 }));
      expect(monitor.getState().lastDegradedReason).toContain("parse-error");
      expect(monitor.getState().lastDegradedReason).toContain("2");
    });

    it("records lastDegradedAt timestamp", () => {
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      expect(monitor.getState().lastDegradedAt).toEqual(new Date("2026-06-18T12:00:00.000Z"));
    });

    it("marks state unhealthy", () => {
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      expect(monitor.getState().healthy).toBe(false);
    });
  });

  describe("placeholder action detection", () => {
    it("increments consecutiveDegradedCycles when placeholderActions > 0", () => {
      monitor.recordCycleStats(stats({ placeholderActions: 1 }));
      expect(monitor.getState().consecutiveDegradedCycles).toBe(1);
    });

    it("sets lastDegradedReason mentioning placeholder", () => {
      monitor.recordCycleStats(stats({ placeholderActions: 1, totalChecks: 1 }));
      expect(monitor.getState().lastDegradedReason).toContain("placeholder");
    });

    it("detects combined parse-error and placeholder (parse-error takes priority in reason)", () => {
      monitor.recordCycleStats(stats({ parseErrors: 1, placeholderActions: 1 }));
      // parse-error is checked first in the implementation
      expect(monitor.getState().lastDegradedReason).toContain("parse-error");
    });
  });

  describe("isHealthy threshold", () => {
    it("returns true when consecutiveDegradedCycles < 3 (default)", () => {
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      expect(monitor.isHealthy()).toBe(true); // 2 < 3
    });

    it("returns false when consecutiveDegradedCycles >= 3 (default)", () => {
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      expect(monitor.isHealthy()).toBe(false); // 3 >= 3
    });

    it("respects custom threshold", () => {
      monitor.recordCycleStats(stats({ parseErrors: 1 }));
      expect(monitor.isHealthy(1)).toBe(false); // 1 >= 1
      expect(monitor.isHealthy(2)).toBe(true);  // 1 < 2
    });
  });

  describe("Kimi degradation scenario", () => {
    it("detects storm after 3 consecutive placeholder cycles", () => {
      // Kimi emits [ENDORSEMENT_CHECK: <brief description of the action>] for 3 cycles
      const kimiDegradedCycle = stats({ totalChecks: 1, parseErrors: 0, placeholderActions: 1 });

      monitor.recordCycleStats(kimiDegradedCycle);
      expect(monitor.isHealthy()).toBe(true);  // 1 degraded, below threshold

      monitor.recordCycleStats(kimiDegradedCycle);
      expect(monitor.isHealthy()).toBe(true);  // 2 degraded, below threshold

      monitor.recordCycleStats(kimiDegradedCycle);
      expect(monitor.isHealthy()).toBe(false); // 3 degraded, at threshold — alarm
    });

    it("detects storm after 3 consecutive parse-error cycles (screener model also degraded)", () => {
      const stormCycle = stats({ totalChecks: 1, parseErrors: 1, placeholderActions: 1 });

      for (let i = 0; i < 3; i++) {
        monitor.recordCycleStats(stormCycle);
      }

      expect(monitor.isHealthy()).toBe(false);
      expect(monitor.getState().lastDegradedReason).toContain("parse-error");
    });
  });

  it("works without a clock (uses real Date)", () => {
    const noClockMonitor = new OutputQualityMonitor();
    noClockMonitor.recordCycleStats(stats({ parseErrors: 0 }));
    expect(noClockMonitor.getState().lastHealthyAt).toBeInstanceOf(Date);
  });
});
