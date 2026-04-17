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
    it("adds a pending [restart] task to PLAN.md", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");

      await manager.saveStateBeforeSleep(resetTime);

      const planPath = config.getFilePath(SubstrateFileType.PLAN);
      const content = await fs.readFile(planPath);

      expect(content).toContain("- [ ] [restart]");
      expect(content).toContain("2026-02-15T12:00:00.000Z");
    });

    it("includes interrupted task ID in restart task when provided", async () => {
      const resetTime = new Date("2026-02-15T12:00:00Z");

      await manager.saveStateBeforeSleep(resetTime, "task-123");

      const planPath = config.getFilePath(SubstrateFileType.PLAN);
      const content = await fs.readFile(planPath);

      expect(content).toContain('Task "task-123" was interrupted.');
    });

    it("does not include interrupted annotation when current task is already complete", async () => {
      await fs.writeFile("/test/substrate/PLAN.md", `# Plan

## Current Goal

Bootstrap the agent system

## Tasks

- [x] Define core values
- [ ] Write initial identity
`);
      const resetTime = new Date("2026-02-15T12:00:00Z");

      await manager.saveStateBeforeSleep(resetTime, "task-1");

      const planPath = config.getFilePath(SubstrateFileType.PLAN);
      const content = await fs.readFile(planPath);

      expect(content).toContain("- [ ] [restart] Resume from rate-limit hibernation");
      expect(content).not.toContain('Task "task-1" was interrupted.');
    });

    it("includes interrupted annotation when current task is still pending", async () => {
      await fs.writeFile("/test/substrate/PLAN.md", `# Plan

## Current Goal

Bootstrap the agent system

## Tasks

- [ ] Define core values
- [ ] Write initial identity
`);
      const resetTime = new Date("2026-02-15T12:00:00Z");

      await manager.saveStateBeforeSleep(resetTime, "task-1");

      const planPath = config.getFilePath(SubstrateFileType.PLAN);
      const content = await fs.readFile(planPath);

      expect(content).toContain('Task "task-1" was interrupted.');
    });

    it("updates PLAN.md with hibernation context in Current Goal", async () => {
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
      expect(content).toContain("- [ ] [restart]");
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
});
