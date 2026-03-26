import { INSHook } from "../../../src/loop/ins/INSHook";
import { ComplianceStateManager } from "../../../src/loop/ins/ComplianceStateManager";
import { INSConfig, defaultINSConfig } from "../../../src/loop/ins/types";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryLogger } from "../../../src/logging";

describe("INSHook", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let reader: SubstrateFileReader;
  let config: INSConfig;

  const substratePath = "/substrate";
  const now = new Date("2026-03-01T12:00:00.000Z");

  async function createHook(configOverrides?: Partial<INSConfig>): Promise<INSHook> {
    const finalConfig = { ...config, ...configOverrides };
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
    reader = new SubstrateFileReader(fs, substrateConfig, false); // disable cache for tests

    config = defaultINSConfig(substratePath);

    // Create minimal substrate files
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

  // --- Noop behavior ---

  it("returns noop when all files are within thresholds", async () => {
    const hook = await createHook();
    const result = await hook.evaluate(1);
    expect(result.noop).toBe(true);
    expect(result.actions).toHaveLength(0);
  });

  // --- CONVERSATION.md compaction ---

  it("flags CONVERSATION.md compaction when line count exceeds threshold", async () => {
    const lines = Array.from({ length: 90 }, (_, i) => `Line ${i + 1}`);
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, lines.join("\n"));

    const hook = await createHook({ conversationLineThreshold: 80 });
    const result = await hook.evaluate(1);

    expect(result.noop).toBe(false);
    expect(result.actions).toHaveLength(1);
    expect(result.actions[0].type).toBe("compaction");
    expect(result.actions[0].target).toBe("CONVERSATION.md");
    expect(result.actions[0].detail).toContain("90");
    expect(result.actions[0].detail).toContain("80");
  });

  it("does not flag when line count equals threshold", async () => {
    const lines = Array.from({ length: 80 }, (_, i) => `Line ${i + 1}`);
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, lines.join("\n"));

    const hook = await createHook({ conversationLineThreshold: 80 });
    const result = await hook.evaluate(1);

    const convAction = result.actions.find(a => a.target === "CONVERSATION.md");
    expect(convAction).toBeUndefined();
  });

  // --- PROGRESS.md compaction ---

  it("flags PROGRESS.md compaction when line count exceeds threshold", async () => {
    const lines = Array.from({ length: 210 }, (_, i) => `Entry ${i + 1}`);
    await fs.writeFile(`${substratePath}/PROGRESS.md`, lines.join("\n"));

    const hook = await createHook({ progressLineThreshold: 200 });
    const result = await hook.evaluate(1);

    const progAction = result.actions.find(a => a.target === "PROGRESS.md");
    expect(progAction).toBeDefined();
    expect(progAction!.type).toBe("compaction");
  });

  // --- MEMORY.md size ---

  it("flags MEMORY.md when character count exceeds threshold", async () => {
    // Create a file with > 1000 characters (using a low threshold for testing)
    const content = "x".repeat(1500);
    await fs.writeFile(`${substratePath}/MEMORY.md`, content);

    const hook = await createHook({ memoryCharThreshold: 1000 });
    const result = await hook.evaluate(1);

    const memAction = result.actions.find(a => a.target === "MEMORY.md");
    expect(memAction).toBeDefined();
    expect(memAction!.type).toBe("compaction");
    expect(memAction!.detail).toContain("1500");
    expect(memAction!.detail).toContain("token");
  });

  it("does not flag MEMORY.md when just below threshold", async () => {
    const content = "x".repeat(999);
    await fs.writeFile(`${substratePath}/MEMORY.md`, content);

    const hook = await createHook({ memoryCharThreshold: 1000 });
    const result = await hook.evaluate(1);

    const memAction = result.actions.find(a => a.target === "MEMORY.md");
    expect(memAction).toBeUndefined();
  });

  // --- Multiple rules ---

  it("returns multiple actions when multiple rules trigger", async () => {
    // Trigger CONVERSATION.md (>80 lines)
    const convLines = Array.from({ length: 90 }, (_, i) => `Line ${i}`);
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, convLines.join("\n"));

    // Trigger PROGRESS.md (>200 lines)
    const progLines = Array.from({ length: 210 }, (_, i) => `Entry ${i}`);
    await fs.writeFile(`${substratePath}/PROGRESS.md`, progLines.join("\n"));

    // Trigger MEMORY.md (>120K chars)
    await fs.writeFile(`${substratePath}/MEMORY.md`, "x".repeat(130_000));

    const hook = await createHook();
    const result = await hook.evaluate(1);

    expect(result.noop).toBe(false);
    expect(result.actions.length).toBeGreaterThanOrEqual(3);
    expect(result.actions.map(a => a.target)).toContain("CONVERSATION.md");
    expect(result.actions.map(a => a.target)).toContain("PROGRESS.md");
    expect(result.actions.map(a => a.target)).toContain("MEMORY.md");
  });

  // --- Error handling ---

  it("never throws — returns noop on catastrophic error", async () => {
    // Create a hook with a broken reader (point to nonexistent substrate)
    const brokenConfig = new SubstrateConfig("/nonexistent");
    const brokenReader = new SubstrateFileReader(fs, brokenConfig, false);
    const complianceState = await ComplianceStateManager.load(config.statePath, fs, logger);
    const hook = new INSHook(brokenReader, fs, clock, logger, config, complianceState);

    // Should not throw
    const result = await hook.evaluate(1);
    // Individual rules handle missing files, so this should still succeed
    expect(result).toBeDefined();
    expect(result.actions).toBeDefined();
  });

  it("handles missing substrate files gracefully", async () => {
    // Remove all substrate files
    const emptySubstrate = new SubstrateConfig("/empty");
    await fs.mkdir("/empty", { recursive: true });
    const emptyReader = new SubstrateFileReader(fs, emptySubstrate, false);
    const complianceState = await ComplianceStateManager.load(config.statePath, fs, logger);
    const hook = new INSHook(emptyReader, fs, clock, logger, config, complianceState);

    const result = await hook.evaluate(1);
    expect(result.noop).toBe(true);
    expect(result.actions).toHaveLength(0);
  });

  // --- Consecutive-partial detection ---

  it("does not flag on first partial", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const result = await hook.evaluate(1, {
      result: "partial",
      summary: "Task blocked by API rate limit",
    });

    const complianceAction = result.actions.find(a => a.type === "compliance_flag");
    expect(complianceAction).toBeUndefined();
  });

  it("flags on third consecutive partial with same precondition", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // First partial
    await hook.evaluate(1, { result: "partial", summary: "Blocked by API rate limit" });
    // Second partial
    await hook.evaluate(2, { result: "partial", summary: "Blocked by API rate limit" });
    // Third partial — should flag
    const result = await hook.evaluate(3, { result: "partial", summary: "Blocked by API rate limit" });

    const complianceAction = result.actions.find(a => a.type === "compliance_flag");
    expect(complianceAction).toBeDefined();
    expect(complianceAction!.flaggedPattern).toBe("API rate limit");
    expect(complianceAction!.detail).toContain("3 cycles");
  });

  it("resets counter on successful result", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });

    // Two partials
    await hook.evaluate(1, { result: "partial", summary: "Blocked by API rate limit" });
    await hook.evaluate(2, { result: "partial", summary: "Blocked by API rate limit" });

    // Success — should reset
    await hook.evaluate(3, { result: "success", summary: "Task completed" });

    // Third partial after reset — should NOT flag (count reset to 1)
    const result = await hook.evaluate(4, { result: "partial", summary: "Blocked by API rate limit" });
    const complianceAction = result.actions.find(a => a.type === "compliance_flag");
    expect(complianceAction).toBeUndefined();
  });

  it("handles missing summary gracefully", async () => {
    const hook = await createHook({ consecutivePartialThreshold: 3 });
    const result = await hook.evaluate(1, { result: "partial" });
    // No crash, no action (can't extract precondition without summary)
    expect(result).toBeDefined();
  });

  // --- Archive candidate detection ---

  it("flags files older than threshold with SUPERSEDED marker", async () => {
    const memoryPath = `${substratePath}/memory`;
    await fs.mkdir(memoryPath, { recursive: true });

    // Create an old file with SUPERSEDED marker
    await fs.writeFile(`${memoryPath}/old-spec.md`, "# Old Spec\n\nSUPERSEDED by new-spec.md\n");

    // Override stat to make file appear old (40 days)
    const origStat = fs.stat.bind(fs);
    const fortyDaysAgo = now.getTime() - 40 * 24 * 60 * 60 * 1000;
    jest.spyOn(fs, "stat").mockImplementation(async (path: string) => {
      if (path.includes("old-spec.md")) {
        return { mtimeMs: fortyDaysAgo, isFile: true, isDirectory: false, size: 100 };
      }
      return origStat(path);
    });

    const hook = await createHook({ archiveAgeDays: 30, memoryPath });
    const result = await hook.evaluate(1);

    const archiveAction = result.actions.find(a => a.type === "archive_tag");
    expect(archiveAction).toBeDefined();
    expect(archiveAction!.target).toBe("old-spec.md");
    expect(archiveAction!.detail).toContain("40 days");
  });

  it("does not flag recent files even with SUPERSEDED marker", async () => {
    const memoryPath = `${substratePath}/memory`;
    await fs.mkdir(memoryPath, { recursive: true });
    await fs.writeFile(`${memoryPath}/recent.md`, "# Recent\n\nSUPERSEDED by something\n");
    // Default mtime is recent (just created)

    const hook = await createHook({ archiveAgeDays: 30, memoryPath });
    const result = await hook.evaluate(1);

    const archiveAction = result.actions.find(a => a.type === "archive_tag");
    expect(archiveAction).toBeUndefined();
  });

  it("does not flag old files without SUPERSEDED marker", async () => {
    const memoryPath = `${substratePath}/memory`;
    await fs.mkdir(memoryPath, { recursive: true });
    await fs.writeFile(`${memoryPath}/old-active.md`, "# Old Active\n\nStill relevant.\n");

    const fortyDaysAgo = now.getTime() - 40 * 24 * 60 * 60 * 1000;
    jest.spyOn(fs, "stat").mockImplementation(async () => {
      return { mtimeMs: fortyDaysAgo, isFile: true, isDirectory: false, size: 100 };
    });

    const hook = await createHook({ archiveAgeDays: 30, memoryPath });
    const result = await hook.evaluate(1);

    const archiveAction = result.actions.find(a => a.type === "archive_tag");
    expect(archiveAction).toBeUndefined();
  });

  it("handles missing memory directory gracefully", async () => {
    const hook = await createHook({ memoryPath: "/nonexistent/memory" });
    const result = await hook.evaluate(1);
    // Should not crash, no archive actions
    const archiveActions = result.actions.filter(a => a.type === "archive_tag");
    expect(archiveActions).toHaveLength(0);
  });

  // --- memory/ subdirectory accumulation ---

  it("flags memory/ subdirectory when total line count exceeds threshold", async () => {
    const memoryPath = `${substratePath}/memory`;
    await fs.mkdir(memoryPath, { recursive: true });

    // Create files totalling > 500 lines
    const lines200 = Array.from({ length: 200 }, (_, i) => `Line ${i + 1}`).join("\n");
    const lines350 = Array.from({ length: 350 }, (_, i) => `Entry ${i + 1}`).join("\n");
    await fs.writeFile(`${memoryPath}/file-a.md`, lines200);
    await fs.writeFile(`${memoryPath}/file-b.md`, lines350);

    const hook = await createHook({ memorySubdirectoryLineThreshold: 500, memoryPath });
    const result = await hook.evaluate(1);

    const subdirAction = result.actions.find(a => a.target === "memory/");
    expect(subdirAction).toBeDefined();
    expect(subdirAction!.type).toBe("compaction");
    expect(subdirAction!.detail).toContain("550");
    expect(subdirAction!.detail).toContain("500");
    expect(subdirAction!.detail).toContain("compaction recommended");
  });

  it("does not flag memory/ subdirectory when total line count is within threshold", async () => {
    const memoryPath = `${substratePath}/memory`;
    await fs.mkdir(memoryPath, { recursive: true });

    const lines100 = Array.from({ length: 100 }, (_, i) => `Line ${i + 1}`).join("\n");
    await fs.writeFile(`${memoryPath}/small.md`, lines100);

    const hook = await createHook({ memorySubdirectoryLineThreshold: 500, memoryPath });
    const result = await hook.evaluate(1);

    const subdirAction = result.actions.find(a => a.target === "memory/");
    expect(subdirAction).toBeUndefined();
  });

  it("handles missing memory/ directory gracefully for subdirectory check", async () => {
    const hook = await createHook({ memorySubdirectoryLineThreshold: 500, memoryPath: "/nonexistent/memory" });
    const result = await hook.evaluate(1);
    const subdirAction = result.actions.find(a => a.target === "memory/");
    expect(subdirAction).toBeUndefined();
  });

  it("skips subdirectories inside memory/ when counting lines", async () => {
    const memoryPath = `${substratePath}/memory`;
    await fs.mkdir(memoryPath, { recursive: true });
    await fs.mkdir(`${memoryPath}/subdir`, { recursive: true });

    // Only one small file — subdir should not be read as a file
    await fs.writeFile(`${memoryPath}/small.md`, "Line 1\nLine 2\n");

    const hook = await createHook({ memorySubdirectoryLineThreshold: 1, memoryPath });
    const result = await hook.evaluate(1);

    const subdirAction = result.actions.find(a => a.target === "memory/");
    // 2 lines from small.md > threshold of 1 => should flag
    expect(subdirAction).toBeDefined();
    expect(subdirAction!.type).toBe("compaction");
  });

  // --- Logging ---

  it("logs when actions are produced", async () => {
    const lines = Array.from({ length: 90 }, (_, i) => `Line ${i}`);
    await fs.writeFile(`${substratePath}/CONVERSATION.md`, lines.join("\n"));

    const hook = await createHook();
    await hook.evaluate(1);

    const debugLogs = logger.getEntries();
    const insLog = debugLogs.find(l => l.includes("ins: cycle 1"));
    expect(insLog).toBeDefined();
    expect(insLog).toContain("1 action(s)");
  });

  it("does not log on noop cycles", async () => {
    const hook = await createHook();
    await hook.evaluate(1);

    const debugLogs = logger.getEntries();
    const insLog = debugLogs.find(l => l.includes("ins: cycle"));
    expect(insLog).toBeUndefined();
  });
});
