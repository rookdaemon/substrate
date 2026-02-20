import { ValidationScheduler } from "../../src/loop/ValidationScheduler";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";

describe("ValidationScheduler", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let scheduler: ValidationScheduler;

  const substratePath = "/test/substrate";
  const stateFilePath = "/test/config/validation-state.txt";
  const INTERVAL_MS = 7 * 24 * 60 * 60 * 1000; // 7 days

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-20T12:00:00Z"));
    logger = new InMemoryLogger();

    scheduler = new ValidationScheduler(fs, clock, logger, {
      substratePath,
      validationIntervalMs: INTERVAL_MS,
      stateFilePath,
    });

    await fs.mkdir(substratePath, { recursive: true });
    await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n\n");
  });

  describe("shouldRunValidation", () => {
    it("returns true on first run (no state)", async () => {
      expect(await scheduler.shouldRunValidation()).toBe(true);
    });

    it("returns false before interval elapsed", async () => {
      await scheduler.runValidation();

      // Advance 3 days (less than 7-day interval)
      clock.setNow(new Date(clock.now().getTime() + 3 * 24 * 60 * 60 * 1000));

      expect(await scheduler.shouldRunValidation()).toBe(false);
    });

    it("returns true after interval elapsed", async () => {
      await scheduler.runValidation();

      // Advance 8 days (more than 7-day interval)
      clock.setNow(new Date(clock.now().getTime() + 8 * 24 * 60 * 60 * 1000));

      expect(await scheduler.shouldRunValidation()).toBe(true);
    });

    it("loads state from disk on first check", async () => {
      // Manually write state file with a recent timestamp
      await fs.mkdir("/test/config", { recursive: true });
      await fs.writeFile(stateFilePath, clock.now().toISOString());

      // Advance 1 day
      clock.setNow(new Date(clock.now().getTime() + 24 * 60 * 60 * 1000));

      expect(await scheduler.shouldRunValidation()).toBe(false);
    });

    it("returns true when state file has invalid date", async () => {
      await fs.mkdir("/test/config", { recursive: true });
      await fs.writeFile(stateFilePath, "not-a-date");

      expect(await scheduler.shouldRunValidation()).toBe(true);
    });
  });

  describe("runValidation", () => {
    it("returns success result with report", async () => {
      const result = await scheduler.runValidation();

      expect(result.success).toBe(true);
      expect(result.report).toBeDefined();
      expect(result.timestamp).toBe(clock.now().toISOString());
    });

    it("appends JSON report to PROGRESS.md", async () => {
      await scheduler.runValidation();

      const progress = await fs.readFile(`${substratePath}/PROGRESS.md`);
      expect(progress).toContain("## Substrate Validation Report");
      expect(progress).toContain('"brokenReferences"');
      expect(progress).toContain('"orphanedFiles"');
      expect(progress).toContain('"staleFiles"');
    });

    it("persists state to disk after successful run", async () => {
      await fs.mkdir("/test/config", { recursive: true });
      await scheduler.runValidation();

      const state = await fs.readFile(stateFilePath);
      expect(state).toBe(clock.now().toISOString());
    });

    it("increments validation count on each run", async () => {
      expect(scheduler.getStatus().validationCount).toBe(0);
      await scheduler.runValidation();
      expect(scheduler.getStatus().validationCount).toBe(1);
      await scheduler.runValidation();
      expect(scheduler.getStatus().validationCount).toBe(2);
    });

    it("does not crash when PROGRESS.md is missing", async () => {
      await fs.unlink(`${substratePath}/PROGRESS.md`);

      const result = await scheduler.runValidation();
      expect(result.success).toBe(true);
    });
  });

  describe("getStatus", () => {
    it("returns null lastValidationTime before first run", () => {
      const status = scheduler.getStatus();
      expect(status.lastValidationTime).toBeNull();
      expect(status.validationCount).toBe(0);
    });

    it("returns nextValidationDue as current time before first run", () => {
      const status = scheduler.getStatus();
      expect(status.nextValidationDue?.getTime()).toBe(clock.now().getTime());
    });

    it("returns correct nextValidationDue after a run", async () => {
      await scheduler.runValidation();

      const status = scheduler.getStatus();
      const expectedDue = new Date(clock.now().getTime() + INTERVAL_MS);
      expect(status.nextValidationDue?.getTime()).toBe(expectedDue.getTime());
    });
  });
});
