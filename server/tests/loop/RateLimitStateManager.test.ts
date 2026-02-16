import { RateLimitStateManager } from "../../src/loop/RateLimitStateManager";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../src/substrate/config";
import { FileLock } from "../../src/substrate/io/FileLock";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileType } from "../../src/substrate/types";

describe("RateLimitStateManager", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let config: SubstrateConfig;
  let lock: FileLock;
  let progressWriter: AppendOnlyWriter;
  let fileWriter: SubstrateFileWriter;
  let fileReader: SubstrateFileReader;
  let manager: RateLimitStateManager;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-15T10:00:00Z"));
    config = new SubstrateConfig("/test/substrate");
    lock = new FileLock();
    progressWriter = new AppendOnlyWriter(fs, config, lock, clock);
    fileWriter = new SubstrateFileWriter(fs, config, lock);
    fileReader = new SubstrateFileReader(fs, config, lock);

    manager = new RateLimitStateManager(
      fs, config, lock, clock, progressWriter, fileWriter, fileReader
    );

    // Setup substrate files
    await fs.mkdir("/test/substrate", { recursive: true });
    await fs.writeFile("/test/substrate/PLAN.md", `# Plan

## Current Goal

Bootstrap the agent system

## Tasks

- [ ] Define core values
- [ ] Write initial identity
`);
    await fs.writeFile("/test/substrate/PROGRESS.md", "# Progress\n");
  });

  describe("saveStateBeforeSleep", () => {
    it("writes restart-context.md with hibernation details", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime);

      const contextPath = config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
      const content = await fs.readFile(contextPath);

      expect(content).toContain("# Restart Context");
      expect(content).toContain("Hibernation Start**: 2026-02-15T10:00:00.000Z");
      expect(content).toContain("Expected Reset**: 2026-02-15T12:00:00.000Z");
      expect(content).toContain("Duration**: ~120 minutes");
    });

    it("includes current goal in restart context", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime);

      const contextPath = config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
      const content = await fs.readFile(contextPath);

      expect(content).toContain("## Current Goal");
      expect(content).toContain("Bootstrap the agent system");
    });

    it("includes interrupted task ID when provided", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime, "task-123");

      const contextPath = config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
      const content = await fs.readFile(contextPath);

      expect(content).toContain("## Interrupted Task");
      expect(content).toContain("Task ID: task-123");
    });

    it("handles missing task ID gracefully", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime);

      const contextPath = config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
      const content = await fs.readFile(contextPath);

      expect(content).toContain("## Interrupted Task");
      expect(content).toContain("No specific task was in progress");
    });

    it("includes full plan snapshot in restart context", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime);

      const contextPath = config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
      const content = await fs.readFile(contextPath);

      expect(content).toContain("## Full Plan Snapshot");
      expect(content).toContain("- [ ] Define core values");
      expect(content).toContain("- [ ] Write initial identity");
    });

    it("updates PLAN.md with hibernation context", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime, "task-123");

      const planPath = config.getFilePath(SubstrateFileType.PLAN);
      const content = await fs.readFile(planPath);

      expect(content).toContain("[RATE LIMITED - resuming at 2026-02-15T12:00:00.000Z]");
      expect(content).toContain('Task "task-123" was interrupted.');
      expect(content).toContain("Bootstrap the agent system");
    });

    it("updates PLAN.md without task ID when none provided", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime);

      const planPath = config.getFilePath(SubstrateFileType.PLAN);
      const content = await fs.readFile(planPath);

      expect(content).toContain("[RATE LIMITED - resuming at 2026-02-15T12:00:00.000Z]");
      expect(content).not.toContain("was interrupted");
    });

    it("logs hibernation to PROGRESS.md with timestamp", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime);

      const progressPath = config.getFilePath(SubstrateFileType.PROGRESS);
      const content = await fs.readFile(progressPath);

      expect(content).toContain("[2026-02-15T10:00:00.000Z]");
      expect(content).toContain("[SYSTEM] Rate limit hibernation starting");
      expect(content).toContain("Reset expected at 2026-02-15T12:00:00.000Z");
      expect(content).toContain("in ~120 minutes");
      expect(content).toContain("State saved to restart-context.md");
    });

    it("handles PLAN.md without Current Goal section", async () => {
      await fs.writeFile("/test/substrate/PLAN.md", `# Plan

## Tasks

- [ ] Some task
`);

      const resetTime = new Date("2026-02-15T12:00:00Z");
      
      await manager.saveStateBeforeSleep(resetTime);

      const planPath = config.getFilePath(SubstrateFileType.PLAN);
      const content = await fs.readFile(planPath);

      expect(content).toContain("[RATE LIMITED - resuming at 2026-02-15T12:00:00.000Z]");
    });

    it("calculates sleep duration correctly for short waits", async () => {
      const resetTime = new Date("2026-02-15T10:05:00Z"); // 5 minutes
      
      await manager.saveStateBeforeSleep(resetTime);

      const progressPath = config.getFilePath(SubstrateFileType.PROGRESS);
      const content = await fs.readFile(progressPath);

      expect(content).toContain("in ~5 minutes");
    });

    it("calculates sleep duration correctly for long waits", async () => {
      const resetTime = new Date("2026-02-15T22:00:00Z"); // 12 hours
      
      await manager.saveStateBeforeSleep(resetTime);

      const progressPath = config.getFilePath(SubstrateFileType.PROGRESS);
      const content = await fs.readFile(progressPath);

      expect(content).toContain("in ~720 minutes");
    });
  });

  describe("clearRestartContext", () => {
    it("restores restart-context.md to neutral state", async () => {
      // First, save hibernation state
      const resetTime = new Date("2026-02-15T12:00:00Z");
      await manager.saveStateBeforeSleep(resetTime, "task-123");

      const contextPath = config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
      let content = await fs.readFile(contextPath);
      
      // Verify it contains hibernation details
      expect(content).toContain("Hibernation Start**: 2026-02-15T10:00:00.000Z");
      expect(content).toContain("Task ID: task-123");

      // Clear it
      await manager.clearRestartContext();

      // Verify it's restored to neutral state
      content = await fs.readFile(contextPath);
      expect(content).toContain("# Restart Context");
      expect(content).toContain("No rate limit hibernation in progress");
      expect(content).not.toContain("Hibernation Start");
      expect(content).not.toContain("Task ID");
    });

    it("works even if restart-context.md doesn't exist", async () => {
      const contextPath = config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
      const exists = await fs.stat(contextPath).then(() => true).catch(() => false);
      expect(exists).toBe(false);

      // Clear it (should create the file with neutral state)
      await manager.clearRestartContext();

      const content = await fs.readFile(contextPath);
      expect(content).toContain("# Restart Context");
      expect(content).toContain("No rate limit hibernation in progress");
    });
  });
});
