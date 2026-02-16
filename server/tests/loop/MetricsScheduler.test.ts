import { MetricsScheduler } from "../../src/loop/MetricsScheduler";
import { TaskClassificationMetrics } from "../../src/evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../../src/evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../../src/evaluation/DelegationTracker";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";

describe("MetricsScheduler", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let taskMetrics: TaskClassificationMetrics;
  let sizeTracker: SubstrateSizeTracker;
  let delegationTracker: DelegationTracker;
  let scheduler: MetricsScheduler;
  
  const substratePath = "/test/substrate";
  const stateFilePath = "/test/config/metrics-state.txt";

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-16T12:00:00Z"));
    logger = new InMemoryLogger();
    
    taskMetrics = new TaskClassificationMetrics(fs, clock, substratePath);
    sizeTracker = new SubstrateSizeTracker(fs, clock, substratePath);
    delegationTracker = new DelegationTracker(fs, clock, substratePath);
    
    scheduler = new MetricsScheduler(
      fs,
      clock,
      logger,
      {
        substratePath,
        metricsIntervalMs: 7 * 24 * 60 * 60 * 1000, // 7 days
        stateFilePath,
      },
      taskMetrics,
      sizeTracker,
      delegationTracker
    );
    
    // Create substrate directory
    await fs.mkdir(substratePath, { recursive: true });
    
    // Create some test substrate files
    await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\nSome content\n");
    await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\nSome content\n");
  });

  describe("shouldRunMetrics", () => {
    it("should return true on first run", async () => {
      const shouldRun = await scheduler.shouldRunMetrics();
      expect(shouldRun).toBe(true);
    });

    it("should return false before interval elapsed", async () => {
      await scheduler.runMetrics();
      
      // Advance 3 days (less than 7-day interval)
      clock.setNow(new Date(clock.now().getTime() + 3 * 24 * 60 * 60 * 1000));
      
      const shouldRun = await scheduler.shouldRunMetrics();
      expect(shouldRun).toBe(false);
    });

    it("should return true after interval elapsed", async () => {
      await scheduler.runMetrics();
      
      // Advance 8 days (more than 7-day interval)
      clock.setNow(new Date(clock.now().getTime() + 8 * 24 * 60 * 60 * 1000));
      
      const shouldRun = await scheduler.shouldRunMetrics();
      expect(shouldRun).toBe(true);
    });

    it("should load state from disk on first check", async () => {
      // Manually create state file
      await fs.mkdir("/test/config", { recursive: true });
      const lastMetricsTime = new Date("2026-02-10T12:00:00Z");
      await fs.writeFile(stateFilePath, lastMetricsTime.toISOString());
      
      // Create new scheduler instance
      const newScheduler = new MetricsScheduler(
        fs, clock, logger,
        { substratePath, metricsIntervalMs: 7 * 24 * 60 * 60 * 1000, stateFilePath },
        taskMetrics, sizeTracker, delegationTracker
      );
      
      // 6 days since last metrics (2026-02-16 - 2026-02-10)
      const shouldRun = await newScheduler.shouldRunMetrics();
      expect(shouldRun).toBe(false); // Not yet 7 days
    });
  });

  describe("runMetrics", () => {
    it("should successfully collect metrics", async () => {
      const result = await scheduler.runMetrics();
      
      expect(result.success).toBe(true);
      expect(result.timestamp).toBe("2026-02-16T12:00:00.000Z");
      expect(result.collected.taskClassifications).toBe(true);
      expect(result.collected.substrateSizes).toBe(true);
      expect(result.collected.delegationRatio).toBe(false); // Skipped (needs GitHub API)
    });

    it("should record size snapshot", async () => {
      await scheduler.runMetrics();
      
      const snapshot = await sizeTracker.getLatestSnapshot();
      expect(snapshot).not.toBeNull();
      expect(snapshot!.files["PLAN.md"]).toBeGreaterThan(0);
    });

    it("should log stats summary", async () => {
      // Add some task classifications
      await taskMetrics.recordClassification("EGO", "decide", "strategic", "opus");
      await taskMetrics.recordClassification("SUBCONSCIOUS", "execute", "tactical", "sonnet");
      
      await scheduler.runMetrics();
      
      const logs = logger.getEntries();
      const statsLog = logs.find(log => log.includes("task classifications"));
      expect(statsLog).toBeDefined();
      expect(statsLog).toContain("2 ops");
    });

    it("should persist state after successful run", async () => {
      await scheduler.runMetrics();
      
      const exists = await fs.exists(stateFilePath);
      expect(exists).toBe(true);
      
      const content = await fs.readFile(stateFilePath);
      expect(content).toBe("2026-02-16T12:00:00.000Z");
    });

    it("should handle errors gracefully", async () => {
      // Force an error by making sizeTracker fail
      const badTracker = new SubstrateSizeTracker(fs, clock, "/nonexistent");
      const badScheduler = new MetricsScheduler(
        fs, clock, logger,
        { substratePath, metricsIntervalMs: 1000, stateFilePath },
        taskMetrics, badTracker, delegationTracker
      );
      
      const result = await badScheduler.runMetrics();
      
      // Should still succeed overall even if size tracking fails
      expect(result.success).toBe(true);
      expect(result.collected.substrateSizes).toBe(true); // Best effort
    });
  });

  describe("getStatus", () => {
    it("should return status with null values before first run", () => {
      const status = scheduler.getStatus();
      
      expect(status.lastMetricsTime).toBeNull();
      expect(status.metricsCount).toBe(0);
      expect(status.nextMetricsDue).not.toBeNull(); // Should be "now"
    });

    it("should return status after successful run", async () => {
      await scheduler.runMetrics();
      
      const status = scheduler.getStatus();
      
      expect(status.lastMetricsTime).toEqual(new Date("2026-02-16T12:00:00Z"));
      expect(status.metricsCount).toBe(1);
      
      const expectedNext = new Date("2026-02-23T12:00:00Z"); // 7 days later
      expect(status.nextMetricsDue).toEqual(expectedNext);
    });

    it("should track metrics count across multiple runs", async () => {
      await scheduler.runMetrics();
      
      clock.setNow(new Date(clock.now().getTime() + 8 * 24 * 60 * 60 * 1000));
      await scheduler.runMetrics();
      
      const status = scheduler.getStatus();
      expect(status.metricsCount).toBe(2);
    });
  });
});
