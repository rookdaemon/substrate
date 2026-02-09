import {
  LoopState,
  defaultLoopConfig,
  CycleResult,
  LoopEvent,
  createInitialMetrics,
} from "../../src/loop/types";

describe("LoopState", () => {
  it("has STOPPED, RUNNING, PAUSED values", () => {
    expect(LoopState.STOPPED).toBe("STOPPED");
    expect(LoopState.RUNNING).toBe("RUNNING");
    expect(LoopState.PAUSED).toBe("PAUSED");
  });
});

describe("defaultLoopConfig", () => {
  it("returns default configuration", () => {
    const config = defaultLoopConfig();

    expect(config.cycleDelayMs).toBe(30000);
    expect(config.superegoAuditInterval).toBe(10);
    expect(config.maxConsecutiveIdleCycles).toBe(1);
  });

  it("allows overriding individual fields", () => {
    const config = defaultLoopConfig({ cycleDelayMs: 500 });

    expect(config.cycleDelayMs).toBe(500);
    expect(config.superegoAuditInterval).toBe(10);
    expect(config.maxConsecutiveIdleCycles).toBe(1);
  });

  it("ignores undefined overrides and keeps defaults", () => {
    const config = defaultLoopConfig({
      cycleDelayMs: undefined,
      superegoAuditInterval: undefined,
      maxConsecutiveIdleCycles: undefined,
    });

    expect(config.cycleDelayMs).toBe(30000);
    expect(config.superegoAuditInterval).toBe(10);
    expect(config.maxConsecutiveIdleCycles).toBe(1);
  });

  it("allows overriding all fields", () => {
    const config = defaultLoopConfig({
      cycleDelayMs: 2000,
      superegoAuditInterval: 20,
      maxConsecutiveIdleCycles: 3,
    });

    expect(config.cycleDelayMs).toBe(2000);
    expect(config.superegoAuditInterval).toBe(20);
    expect(config.maxConsecutiveIdleCycles).toBe(3);
  });
});

describe("createInitialMetrics", () => {
  it("returns zero counters", () => {
    const metrics = createInitialMetrics();

    expect(metrics.totalCycles).toBe(0);
    expect(metrics.successfulCycles).toBe(0);
    expect(metrics.failedCycles).toBe(0);
    expect(metrics.idleCycles).toBe(0);
    expect(metrics.consecutiveIdleCycles).toBe(0);
    expect(metrics.superegoAudits).toBe(0);
  });
});

describe("CycleResult type", () => {
  it("can represent a dispatch result", () => {
    const result: CycleResult = {
      cycleNumber: 1,
      action: "dispatch",
      taskId: "task-1",
      success: true,
      summary: "Completed task",
    };

    expect(result.action).toBe("dispatch");
    expect(result.taskId).toBe("task-1");
    expect(result.success).toBe(true);
  });

  it("can represent an idle result", () => {
    const result: CycleResult = {
      cycleNumber: 2,
      action: "idle",
      success: true,
      summary: "No tasks available",
    };

    expect(result.action).toBe("idle");
    expect(result.taskId).toBeUndefined();
  });
});

describe("LoopEvent type", () => {
  it("can represent a state_changed event", () => {
    const event: LoopEvent = {
      type: "state_changed",
      timestamp: "2025-06-15T10:00:00.000Z",
      data: { from: LoopState.STOPPED, to: LoopState.RUNNING },
    };

    expect(event.type).toBe("state_changed");
  });

  it("can represent a cycle_complete event", () => {
    const event: LoopEvent = {
      type: "cycle_complete",
      timestamp: "2025-06-15T10:00:01.000Z",
      data: { cycleNumber: 1, action: "dispatch" },
    };

    expect(event.type).toBe("cycle_complete");
  });

  it("can represent an idle event", () => {
    const event: LoopEvent = {
      type: "idle",
      timestamp: "2025-06-15T10:00:02.000Z",
      data: { consecutiveIdleCycles: 3 },
    };

    expect(event.type).toBe("idle");
  });
});
