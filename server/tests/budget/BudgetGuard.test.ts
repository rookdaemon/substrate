import { BudgetGuard, BudgetGuardError, SpendLedger } from "../../src/budget/BudgetGuard";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";

describe("BudgetGuard", () => {
  const substratePath = "/substrate";

  it("records append-only preflight and post-call ledger entries with a valid hash chain", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-05-02T12:00:00.000Z"));
    const guard = BudgetGuard.forSubstratePath(substratePath, fs, clock, undefined, {
      monthlyBudgetUsd: 30,
    });

    await guard.preflight({
      provider: "codex",
      model: "gpt-5.4-mini",
      role: "SUBCONSCIOUS",
      operation: "execute",
      estimatedPromptTokens: 1000,
      estimatedCompletionTokens: 100,
    });
    await guard.recordPostCall({
      provider: "codex",
      model: "gpt-5.4-mini",
      role: "SUBCONSCIOUS",
      operation: "execute",
      startedAt: "2026-05-02T12:00:00.000Z",
      completedAt: "2026-05-02T12:00:01.000Z",
      success: true,
      durationMs: 1000,
      usage: {
        provider: "codex",
        model: "gpt-5.4-mini",
        costUsd: 0.002,
        costKnown: false,
        costEstimate: true,
        billingSource: "static_estimate",
        telemetrySource: "test",
        totalTokens: 1100,
      },
    });

    const ledger = SpendLedger.forSubstratePath(substratePath, fs);
    const records = await ledger.readRecords();
    expect(records.map((r) => r.eventType)).toEqual(["preflight_estimate", "post_call_usage"]);
    expect(records[0].counted).toBe(false);
    expect(records[1]).toEqual(expect.objectContaining({
      counted: true,
      amountUsd: 0.002,
      provider: "codex",
      model: "gpt-5.4-mini",
      role: "SUBCONSCIOUS",
      operation: "execute",
    }));
    await expect(ledger.verifyHashChain()).resolves.toBe(true);

    await expect(guard.summarizeCurrentMonth()).resolves.toEqual(expect.objectContaining({
      month: "2026-05",
      spentUsd: 0.002,
      estimatedUsd: 0.002,
      sessions: 1,
      thresholdPercent: 0,
    }));
  });

  it("preserves prior ledger records when appending later calls", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-05-02T12:00:00.000Z"));
    const guard = BudgetGuard.forSubstratePath(substratePath, fs, clock);

    await guard.recordPostCall(makePostCall(0.25));
    const firstLedger = await fs.readFile("/substrate/.metrics/spend-ledger.jsonl");

    await guard.recordPostCall(makePostCall(0.5));
    const secondLedger = await fs.readFile("/substrate/.metrics/spend-ledger.jsonl");

    expect(secondLedger.startsWith(firstLedger)).toBe(true);
    const records = await SpendLedger.forSubstratePath(substratePath, fs).readRecords();
    expect(records.map((record) => record.sequence)).toEqual([1, 2]);
    expect(records[1].previousHash).toBe(records[0].hash);
  });

  it("detects ledger tampering through hash-chain verification", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-05-02T12:00:00.000Z"));
    const guard = BudgetGuard.forSubstratePath(substratePath, fs, clock);
    const ledger = SpendLedger.forSubstratePath(substratePath, fs);

    await guard.recordPostCall(makePostCall(0.25));
    const [record] = await ledger.readRecords();
    await fs.writeFile("/substrate/.metrics/spend-ledger.jsonl", `${JSON.stringify({
      ...record,
      amountUsd: 0.01,
    })}\n`);

    await expect(ledger.verifyHashChain()).resolves.toBe(false);
  });

  it("uses the configured unknown-cost estimate for preflight gating", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-05-02T12:00:00.000Z"));
    const guard = BudgetGuard.forSubstratePath(substratePath, fs, clock, undefined, {
      monthlyBudgetUsd: 10,
      defaultUnknownEstimateUsd: 2.5,
    });

    await guard.preflight({
      provider: "codex",
      model: "new-unpriced-model",
      role: "SUBCONSCIOUS",
      operation: "execute",
    });

    const records = await SpendLedger.forSubstratePath(substratePath, fs).readRecords();
    expect(records[0]).toEqual(expect.objectContaining({
      eventType: "preflight_estimate",
      amountUsd: 2.5,
      amountKind: "default_estimate",
      billingSource: "unknown",
      telemetrySource: "budgetguard-default-estimate",
      thresholdPercent: 0,
      counted: false,
    }));
  });

  it("updates threshold state and emits Stefan alert hook records at 75 and 90 percent", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-05-02T12:00:00.000Z"));
    const thresholds: number[] = [];
    const guard = BudgetGuard.forSubstratePath(substratePath, fs, clock, undefined, {
      monthlyBudgetUsd: 10,
    }, {
      onThresholdCrossed: (state) => thresholds.push(state.thresholdPercent),
    });

    await guard.recordPostCall(makePostCall(7.5));
    await guard.recordPostCall(makePostCall(1.5));

    expect(thresholds).toEqual([75, 90]);
    const state = JSON.parse(await fs.readFile("/substrate/.metrics/budgetguard-state.json"));
    expect(state).toEqual(expect.objectContaining({
      month: "2026-05",
      spentUsd: 9,
      thresholdPercent: 90,
      stefanAlertRequired: true,
      hibernateRequested: false,
    }));
    const alerts = (await fs.readFile("/substrate/.metrics/budgetguard-alerts.jsonl")).trim().split("\n");
    expect(alerts).toHaveLength(2);
  });

  it("blocks pre-dispatch when projected monthly spend reaches the kill threshold", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-05-02T12:00:00.000Z"));
    const exhausted: number[] = [];
    const guard = BudgetGuard.forSubstratePath(substratePath, fs, clock, undefined, {
      monthlyBudgetUsd: 1,
      defaultUnknownEstimateUsd: 1,
    }, {
      onBudgetExhausted: (state) => exhausted.push(state.thresholdPercent),
    });

    await expect(guard.preflight({
      provider: "codex",
      model: "unknown-paid-model",
      role: "EGO",
      operation: "decide",
    })).rejects.toBeInstanceOf(BudgetGuardError);

    expect(exhausted).toEqual([100]);
    const records = await SpendLedger.forSubstratePath(substratePath, fs).readRecords();
    expect(records[0]).toEqual(expect.objectContaining({
      eventType: "preflight_blocked",
      counted: false,
      thresholdPercent: 100,
    }));
    const state = JSON.parse(await fs.readFile("/substrate/.metrics/budgetguard-state.json"));
    expect(state.hibernateRequested).toBe(true);
  });
});

function makePostCall(costUsd: number) {
  return {
    provider: "codex" as const,
    model: "gpt-5.4-mini",
    role: "SUBCONSCIOUS",
    operation: "execute",
    startedAt: "2026-05-02T12:00:00.000Z",
    completedAt: "2026-05-02T12:00:01.000Z",
    success: true,
    durationMs: 1000,
    usage: {
      provider: "codex" as const,
      model: "gpt-5.4-mini",
      costUsd,
      costKnown: false,
      costEstimate: true,
      billingSource: "static_estimate" as const,
      telemetrySource: "test",
    },
  };
}
