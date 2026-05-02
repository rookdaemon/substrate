import { INSHook } from "../../../src/loop/ins/INSHook";
import { ComplianceStateManager } from "../../../src/loop/ins/ComplianceStateManager";
import { INSConfig, defaultINSConfig, InsAcknowledgment } from "../../../src/loop/ins/types";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryLogger } from "../../../src/logging";

describe("INSHook Phase 3 — compliance pattern detection", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let reader: SubstrateFileReader;
  let config: INSConfig;

  const substratePath = "/substrate";
  const now = new Date("2026-03-01T12:00:00.000Z");

  async function createHook(configOverrides?: Partial<INSConfig>): Promise<INSHook> {
    const finalConfig = {
      ...config,
      survivalIntegrity: { ...config.survivalIntegrity, enabled: false },
      ...configOverrides,
    };
    const complianceState = await ComplianceStateManager.load(
      finalConfig.statePath, fs, logger,
    );
    return new INSHook(reader, fs, clock, logger, finalConfig, complianceState);
  }

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(now);
    logger = new InMemoryLogger();

    const substrateConfig = new SubstrateConfig(substratePath);
    reader = new SubstrateFileReader(fs, substrateConfig, false);

    config = defaultINSConfig(substratePath);

    await fs.mkdir(substratePath, { recursive: true });
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, "# Conversation\n\nLine 1\nLine 2\n");
    await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n\nEntry 1\n");
    await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n\nShort content.\n");
    await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n\n- [ ] Task A\n");
    await fs.writeFile(`${substratePath}/HABITS.md`, "# Habits\n\n");
    await fs.writeFile(`${substratePath}/SKILLS.md`, "# Skills\n\n");
    await fs.writeFile(`${substratePath}/VALUES.md`, "# Values\n\n");
    await fs.writeFile(`${substratePath}/ID.md`, "# Id\n\n");
    await fs.writeFile(`${substratePath}/SECURITY.md`, "# Security\n\n");
    await fs.writeFile(`${substratePath}/CHARTER.md`, "# Charter\n\n");
    await fs.writeFile(`${substratePath}/SUPEREGO.md`, "# Superego\n\n");
    await fs.writeFile(`${substratePath}/CLAUDE.md`, "# Claude\n\n");
    await fs.writeFile(`${substratePath}/PEERS.md`, "# Peers\n\n");
  });

  // --- Role filter ---

  it("Ego partials are NOT tracked (role filter)", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // Simulate 3 Ego partials — should never trigger
    for (let i = 1; i <= 3; i++) {
      const result = await hook.evaluate(i, {
        result: "partial",
        role: "Ego",
        taskId: "task-ego-1",
        blockedReason: "Blocked by user approval",
      });
      const flagAction = result.actions.find(a => a.type === "compliance_flag");
      expect(flagAction).toBeUndefined();
    }
  });

  it("Subconscious partials ARE tracked", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId: "task-sub-1", blockedReason: "Blocked by external dependency" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId: "task-sub-1", blockedReason: "Blocked by external dependency" });
    const result = await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId: "task-sub-1", blockedReason: "Blocked by external dependency" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
  });

  it("Superego partials ARE tracked", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    await hook.evaluate(1, { result: "partial", role: "Superego", taskId: "task-sup-1", blockedReason: "BLOCK: scope limit exceeded" });
    await hook.evaluate(2, { result: "partial", role: "Superego", taskId: "task-sup-1", blockedReason: "BLOCK: scope limit exceeded" });
    const result = await hook.evaluate(3, { result: "partial", role: "Superego", taskId: "task-sup-1", blockedReason: "BLOCK: scope limit exceeded" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.target).toBe("Superego");
  });

  // --- PatternId scheme ---

  it("3 Subconscious partials with same taskId → compliance_flag with correct patternId format", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const taskId = "task-abc-123";

    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId, blockedReason: "Waiting for service deployment" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId, blockedReason: "Waiting for service deployment" });
    const result = await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId, blockedReason: "Waiting for service deployment" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.patternId).toBe(`consecutive-partial::${taskId}`);
    expect(flagAction!.cyclesCount).toBe(3);
    expect(flagAction!.firstSeenCycle).toBe(1);
  });

  it("patternId uses hash fallback when no taskId is provided", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    await hook.evaluate(1, { result: "partial", blockedReason: "Waiting for service deployment response from upstream" });
    await hook.evaluate(2, { result: "partial", blockedReason: "Waiting for service deployment response from upstream" });
    const result = await hook.evaluate(3, { result: "partial", blockedReason: "Waiting for service deployment response from upstream" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    // Hash fallback: hex digits after the :: separator (up to 8 hex chars from 32-bit hash)
    expect(flagAction!.patternId).toMatch(/^consecutive-partial::[0-9a-f]{1,8}$/);
    // Should NOT be the taskId format (no alphabetic task id after ::)
    expect(flagAction!.patternId).not.toMatch(/^consecutive-partial::[a-z]+-[a-z]+-\d+$/);
  });

  it("compliance_flag detail includes role name and cyclesCount", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId: "task-x", blockedReason: "Awaiting credential rotation" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId: "task-x", blockedReason: "Awaiting credential rotation" });
    const result = await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId: "task-x", blockedReason: "Awaiting credential rotation" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.detail).toContain("3 cycles");
    expect(flagAction!.detail).toContain("Subconscious");
    expect(flagAction!.flaggedPattern).toBe("Awaiting credential rotation");
  });

  // --- Jaccard similarity matching ---

  it("3 partials with varying summary but Jaccard ≥ 0.6 → single compliance_flag (pattern merged)", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // These three sentences share most content words (high Jaccard) and exceed 10 tokens each
    const base = "this task cannot proceed because the external deployment service is unavailable and we need to wait for it to become available before continuing";
    const variant1 = "this task cannot proceed because the external deployment service is unavailable and we must wait for it to become available before continuing";
    const variant2 = "this task cannot proceed because the external deployment service is unavailable and we are waiting for it to become available before continuing";

    // No taskId so pattern matching falls back to Jaccard
    await hook.evaluate(1, { result: "partial", role: "Subconscious", blockedReason: base });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", blockedReason: variant1 });
    const result = await hook.evaluate(3, { result: "partial", role: "Subconscious", blockedReason: variant2 });

    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    // All three should be counted under one patternId (Jaccard merged)
    expect(flagActions).toHaveLength(1);
    expect(flagActions[0].cyclesCount).toBe(3);
  });

  it("partials with low Jaccard similarity are tracked separately", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // These two strings are semantically very different
    const reasonA = "waiting for the deployment pipeline to finish building the container image before proceeding";
    const reasonB = "blocked because the database schema migration requires manual approval from the dba team";

    await hook.evaluate(1, { result: "partial", role: "Subconscious", blockedReason: reasonA });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", blockedReason: reasonB });
    await hook.evaluate(3, { result: "partial", role: "Subconscious", blockedReason: reasonA });
    const result = await hook.evaluate(4, { result: "partial", role: "Subconscious", blockedReason: reasonB });

    // Each pattern has only 2 occurrences — neither at threshold of 3
    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    expect(flagActions).toHaveLength(0);
  });

  // --- Jaccard floor: short strings use substring matching ---

  it("short strings (< 10 tokens) use substring matching, not Jaccard", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // Short strings — both < 10 tokens, one is substring of the other
    const short1 = "blocked by rate limit";
    const short2 = "API rate limit exceeded";  // shares "rate limit" but not a substring of short1

    // With substring matching: short1.includes(short2) = false, short2.includes(short1) = false
    // So these should be treated as distinct patterns
    await hook.evaluate(1, { result: "partial", role: "Subconscious", blockedReason: short1 });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", blockedReason: short2 });
    await hook.evaluate(3, { result: "partial", role: "Subconscious", blockedReason: short1 });
    const result = await hook.evaluate(4, { result: "partial", role: "Subconscious", blockedReason: short2 });

    // Neither has 3 occurrences under the same pattern — no flag
    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    expect(flagActions).toHaveLength(0);
  });

  it("short string substring match: longer string contains shorter → merged", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    const short = "rate limit";          // 2 tokens
    const longer = "blocked by rate limit";  // 4 tokens, contains "rate limit"

    // short is a substring of longer (normalized) → should merge
    await hook.evaluate(1, { result: "partial", role: "Subconscious", blockedReason: longer });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", blockedReason: short });
    const result = await hook.evaluate(3, { result: "partial", role: "Subconscious", blockedReason: longer });

    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    // All 3 merged under one pattern
    expect(flagActions).toHaveLength(1);
    expect(flagActions[0].cyclesCount).toBe(3);
  });

  // --- Acknowledgment round-trip ---

  it("acknowledged pattern with valid TTL → flag suppressed", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const taskId = "task-ack-1";

    // Build up 3 partials to trigger flag
    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId, blockedReason: "Waiting for budget approval" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId, blockedReason: "Waiting for budget approval" });
    await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId, blockedReason: "Waiting for budget approval" });

    // Now Ego acknowledges the pattern as real_constraint
    const patternId = `consecutive-partial::${taskId}`;
    const ack: InsAcknowledgment = { patternId, verdict: "real_constraint", taskStatus: "deferred" };

    // Cycle 4: acknowledgment comes in + another partial
    const result = await hook.evaluate(4, {
      result: "partial",
      role: "Subconscious",
      taskId,
      blockedReason: "Waiting for budget approval",
      insAcknowledgments: [ack],
    });

    // Flag should be suppressed (acknowledged, TTL is 7 days from now)
    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    expect(flagActions).toHaveLength(0);
  });

  it("false_positive verdict → pattern cleared immediately", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const taskId = "task-fp-1";

    // Build up 3 partials
    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId, blockedReason: "Blocked by imaginary constraint" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId, blockedReason: "Blocked by imaginary constraint" });
    await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId, blockedReason: "Blocked by imaginary constraint" });

    const patternId = `consecutive-partial::${taskId}`;
    const ack: InsAcknowledgment = { patternId, verdict: "false_positive" };

    // Cycle 4: false_positive ack + partial — pattern should be cleared, then re-added as count=1
    const result = await hook.evaluate(4, {
      result: "partial",
      role: "Subconscious",
      taskId,
      blockedReason: "Blocked by imaginary constraint",
      insAcknowledgments: [ack],
    });

    // Pattern was cleared then re-added as count=1, threshold is 3 — no flag
    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    expect(flagActions).toHaveLength(0);
  });

  it("insAcknowledgments are processed independently of task result", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const taskId = "task-ack-2";

    // Build up 3 partials
    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId, blockedReason: "Precondition: external service ready" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId, blockedReason: "Precondition: external service ready" });
    await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId, blockedReason: "Precondition: external service ready" });

    const patternId = `consecutive-partial::${taskId}`;
    const ack: InsAcknowledgment = { patternId, verdict: "real_constraint", taskStatus: "pending" };

    // Ack comes in via Ego (role=Ego, success result) — acks should still be processed
    // even though Ego result itself is filtered from partial tracking
    const result = await hook.evaluate(4, {
      result: "success",
      role: "Ego",
      taskId,
      insAcknowledgments: [ack],
    });

    // No flag — acknowledged with valid TTL
    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    expect(flagActions).toHaveLength(0);
  });

  // --- Backward compatibility: no role/taskId ---

  it("backward compat: no role or taskId still tracks partials (legacy path)", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // No role, no taskId — should default to Subconscious, use hash-based patternId
    await hook.evaluate(1, { result: "partial", summary: "Task blocked by API rate limit" });
    await hook.evaluate(2, { result: "partial", summary: "Task blocked by API rate limit" });
    const result = await hook.evaluate(3, { result: "partial", summary: "Task blocked by API rate limit" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.target).toBe("Subconscious"); // defaults to Subconscious
  });

  it("backward compat: success with no taskId clears all patterns", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    await hook.evaluate(1, { result: "partial", summary: "Task blocked by API rate limit" });
    await hook.evaluate(2, { result: "partial", summary: "Task blocked by API rate limit" });

    // Success with no taskId — clears all
    await hook.evaluate(3, { result: "success" });

    // Next partial — count resets
    const result = await hook.evaluate(4, { result: "partial", summary: "Task blocked by API rate limit" });
    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeUndefined();
  });

  it("success with taskId clears only that task's pattern, not others", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // Two separate tasks accumulating partials
    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId: "task-A", blockedReason: "Waiting for service A" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId: "task-B", blockedReason: "Waiting for service B" });
    await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId: "task-A", blockedReason: "Waiting for service A" });
    await hook.evaluate(4, { result: "partial", role: "Subconscious", taskId: "task-B", blockedReason: "Waiting for service B" });

    // Task A succeeds — clears only task-A
    await hook.evaluate(5, { result: "success", role: "Subconscious", taskId: "task-A" });

    // Task B continues — reaches threshold on next two cycles
    await hook.evaluate(6, { result: "partial", role: "Subconscious", taskId: "task-B", blockedReason: "Waiting for service B" });
    const result = await hook.evaluate(7, { result: "partial", role: "Subconscious", taskId: "task-B", blockedReason: "Waiting for service B" });

    const flagActions = result.actions.filter(a => a.type === "compliance_flag");
    expect(flagActions).toHaveLength(1);
    expect(flagActions[0].patternId).toBe("consecutive-partial::task-B");
  });

  // --- blockedReason preferred over summary ---

  it("blockedReason is preferred over summary for pattern text", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const taskId = "task-br-1";

    const blockedReason = "Explicit blocked reason from structured output";
    const summary = "Task partial — Blocked by some other issue in summary";

    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId, blockedReason, summary });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId, blockedReason, summary });
    const result = await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId, blockedReason, summary });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.flaggedPattern).toBe(blockedReason);
    expect(flagAction!.flaggedPattern).not.toContain("summary");
  });

  // --- Cycle count and firstSeenCycle in action ---

  it("cyclesCount and firstSeenCycle are correctly populated in compliance_flag", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const taskId = "task-meta-1";

    await hook.evaluate(10, { result: "partial", role: "Subconscious", taskId, blockedReason: "Resource unavailable" });
    await hook.evaluate(15, { result: "partial", role: "Subconscious", taskId, blockedReason: "Resource unavailable" });
    const result = await hook.evaluate(20, { result: "partial", role: "Subconscious", taskId, blockedReason: "Resource unavailable" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.cyclesCount).toBe(3);
    expect(flagAction!.firstSeenCycle).toBe(10);
  });

  // --- Phase 1 schema migration ---

  it("loads Phase 1 compliance.json schema and migrates to fresh state", async () => {
    const statePath = config.statePath;
    await fs.mkdir(statePath, { recursive: true });

    // Write Phase 1 format
    const phase1State = {
      partials: {
        "API rate limit": { count: 5, firstCycle: 1, lastCycle: 5 },
      },
      lastUpdatedCycle: 5,
    };
    await fs.writeFile(`${statePath}/compliance.json`, JSON.stringify(phase1State));

    // Load — should migrate to fresh state (no patterns)
    const manager = await ComplianceStateManager.load(statePath, fs, logger);
    const state = manager.getState();
    expect(state.patterns).toHaveLength(0);
  });
});

// --- Gap 1: Compliance routing (requiresStefanReview) ---

describe("INSHook — compliance routing (Gap 1)", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let reader: SubstrateFileReader;
  let config: INSConfig;

  const substratePath = "/substrate";
  const now = new Date("2026-03-01T12:00:00.000Z");

  async function createHook(configOverrides?: Partial<INSConfig>): Promise<INSHook> {
    const finalConfig = {
      ...config,
      survivalIntegrity: { ...config.survivalIntegrity, enabled: false },
      ...configOverrides,
    };
    const complianceState = await ComplianceStateManager.load(finalConfig.statePath, fs, logger);
    return new INSHook(reader, fs, clock, logger, finalConfig, complianceState);
  }

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(now);
    logger = new InMemoryLogger();
    const substrateConfig = new SubstrateConfig(substratePath);
    reader = new SubstrateFileReader(fs, substrateConfig, false);
    config = defaultINSConfig(substratePath);

    await fs.mkdir(substratePath, { recursive: true });
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, "# Conversation\n\n");
    await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n\n");
    await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n\n");
    await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n\n- [ ] Task A\n");
    await fs.writeFile(`${substratePath}/HABITS.md`, "# Habits\n\n");
    await fs.writeFile(`${substratePath}/SKILLS.md`, "# Skills\n\n");
    await fs.writeFile(`${substratePath}/VALUES.md`, "# Values\n\n");
    await fs.writeFile(`${substratePath}/ID.md`, "# Id\n\n");
    await fs.writeFile(`${substratePath}/SECURITY.md`, "# Security\n\n");
    await fs.writeFile(`${substratePath}/CHARTER.md`, "# Charter\n\n");
    await fs.writeFile(`${substratePath}/SUPEREGO.md`, "# Superego\n\n");
    await fs.writeFile(`${substratePath}/CLAUDE.md`, "# Claude\n\n");
    await fs.writeFile(`${substratePath}/PEERS.md`, "# Peers\n\n");
  });

  it("compliance_flag actions have requiresStefanReview=true", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    await hook.evaluate(1, { result: "partial", role: "Subconscious", taskId: "task-1", blockedReason: "Blocked by external dependency" });
    await hook.evaluate(2, { result: "partial", role: "Subconscious", taskId: "task-1", blockedReason: "Blocked by external dependency" });
    const result = await hook.evaluate(3, { result: "partial", role: "Subconscious", taskId: "task-1", blockedReason: "Blocked by external dependency" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.requiresStefanReview).toBe(true);
  });

  it("compliance_flag always has requiresStefanReview=true for Superego patterns too", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    await hook.evaluate(1, { result: "partial", role: "Superego", taskId: "task-sup-1", blockedReason: "BLOCK: scope limit exceeded" });
    await hook.evaluate(2, { result: "partial", role: "Superego", taskId: "task-sup-1", blockedReason: "BLOCK: scope limit exceeded" });
    const result = await hook.evaluate(3, { result: "partial", role: "Superego", taskId: "task-sup-1", blockedReason: "BLOCK: scope limit exceeded" });

    const flagAction = result.actions.find(a => a.type === "compliance_flag");
    expect(flagAction).toBeDefined();
    expect(flagAction!.requiresStefanReview).toBe(true);
  });
});

// --- Gap 3: Threshold governance ---

import { INS_THRESHOLD_GOVERNANCE, assertINSThresholdsAreStefanGated } from "../../../src/loop/ins/types";

describe("INS threshold governance (Gap 3)", () => {
  it("INS_THRESHOLD_GOVERNANCE contains all Stefan-gated threshold defaults", () => {
    expect(INS_THRESHOLD_GOVERNANCE.conversationLineThreshold).toBe(80);
    expect(INS_THRESHOLD_GOVERNANCE.progressLineThreshold).toBe(200);
    expect(INS_THRESHOLD_GOVERNANCE.planLineThreshold).toBe(150);
    expect(INS_THRESHOLD_GOVERNANCE.memoryCharThreshold).toBe(120_000);
    expect(INS_THRESHOLD_GOVERNANCE.memorySubdirectoryLineThreshold).toBe(500);
    expect(INS_THRESHOLD_GOVERNANCE.consecutivePartialThreshold).toBe(3);
    expect(INS_THRESHOLD_GOVERNANCE.archiveAgeDays).toBe(30);
  });

  it("assertINSThresholdsAreStefanGated passes for default config", () => {
    const config = defaultINSConfig("/substrate");
    expect(() => assertINSThresholdsAreStefanGated(config)).not.toThrow();
  });

  it("assertINSThresholdsAreStefanGated throws if consecutivePartialThreshold is modified", () => {
    const config = { ...defaultINSConfig("/substrate"), consecutivePartialThreshold: 1 };
    expect(() => assertINSThresholdsAreStefanGated(config)).toThrow(/Stefan-gated/);
    expect(() => assertINSThresholdsAreStefanGated(config)).toThrow(/consecutivePartialThreshold/);
  });

  it("assertINSThresholdsAreStefanGated throws if conversationLineThreshold is modified", () => {
    const config = { ...defaultINSConfig("/substrate"), conversationLineThreshold: 9999 };
    expect(() => assertINSThresholdsAreStefanGated(config)).toThrow(/Stefan-gated/);
  });

  it("assertINSThresholdsAreStefanGated throws if archiveAgeDays is modified", () => {
    const config = { ...defaultINSConfig("/substrate"), archiveAgeDays: 1 };
    expect(() => assertINSThresholdsAreStefanGated(config)).toThrow(/Stefan-gated/);
  });
});
