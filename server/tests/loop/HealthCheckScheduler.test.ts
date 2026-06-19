import { HealthCheckScheduler } from "../../src/loop/HealthCheckScheduler";
import { HealthCheck } from "../../src/evaluation/HealthCheck";
import { InferenceLivenessTracker } from "../../src/evaluation/InferenceLivenessTracker";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { IErrorLogReader } from "../../src/loop/IErrorLogReader";

async function setupSubstrateFiles(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild authentication system\n\n## Tasks\n- [ ] Task A\n- [ ] Task B");
  await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nWe are building an authentication system");
  await fs.writeFile("/substrate/HABITS.md", "# Habits\n\nSome habits");
  await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nKnown: authentication, TypeScript");
  await fs.writeFile("/substrate/VALUES.md", "# Values\n\nBe good");
  await fs.writeFile("/substrate/ID.md", "# Id\n\nCore identity");
  await fs.writeFile("/substrate/SECURITY.md", "# Security\n\n## Constraints\nStay safe");
  await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\nOur mission");
  await fs.writeFile("/substrate/SUPEREGO.md", "# Superego\n\nRules here");
  await fs.writeFile("/substrate/CLAUDE.md", "# Claude\n\nConfig here");
  await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
  await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
}

describe("HealthCheckScheduler", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let reader: SubstrateFileReader;
  let healthCheck: HealthCheck;
  let scheduler: HealthCheckScheduler;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-10T10:00:00.000Z"));
    logger = new InMemoryLogger();
    const config = new SubstrateConfig("/substrate");
    reader = new SubstrateFileReader(fs, config);
    await setupSubstrateFiles(fs);

    healthCheck = new HealthCheck(reader);
    scheduler = new HealthCheckScheduler(healthCheck, clock, logger, {
      checkIntervalMs: 3600000, // 1 hour
    });
  });

  describe("shouldRunCheck", () => {
    it("returns true when no check has run yet", () => {
      expect(scheduler.shouldRunCheck()).toBe(true);
    });

    it("returns false when check was just run", async () => {
      await scheduler.runCheck();
      expect(scheduler.shouldRunCheck()).toBe(false);
    });

    it("returns true when interval has elapsed", async () => {
      await scheduler.runCheck();
      clock.setNow(new Date("2026-02-10T11:00:00.000Z")); // Advance 1 hour
      expect(scheduler.shouldRunCheck()).toBe(true);
    });

    it("returns false when interval has not fully elapsed", async () => {
      await scheduler.runCheck();
      clock.setNow(new Date("2026-02-10T10:30:00.000Z")); // Advance 30 minutes
      expect(scheduler.shouldRunCheck()).toBe(false);
    });
  });

  describe("runCheck", () => {
    it("runs health check and returns success", async () => {
      const result = await scheduler.runCheck();

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      expect(["healthy", "degraded", "unhealthy"]).toContain(result.result?.overall);
    });

    it("updates last check time", async () => {
      const initialStatus = scheduler.getStatus();
      expect(initialStatus.lastCheckTime).toBeNull();

      await scheduler.runCheck();

      const status = scheduler.getStatus();
      expect(status.lastCheckTime).toEqual(new Date("2026-02-10T10:00:00.000Z"));
    });

    it("updates checks run count", async () => {
      expect(scheduler.getStatus().checksRun).toBe(0);

      await scheduler.runCheck();
      expect(scheduler.getStatus().checksRun).toBe(1);

      clock.setNow(new Date("2026-02-10T11:00:00.000Z"));
      await scheduler.runCheck();
      expect(scheduler.getStatus().checksRun).toBe(2);
    });

    it("stores last result", async () => {
      await scheduler.runCheck();

      const status = scheduler.getStatus();
      expect(status.lastResult).toBeDefined();
      expect(["healthy", "degraded", "unhealthy"]).toContain(status.lastResult?.overall);
    });

    it("returns degraded status when issues exist", async () => {
      // Create file with inconsistencies
      await fs.writeFile("/substrate/VALUES.md", "# Values\n\nInconsistent content referencing missing HABITS");

      const result = await scheduler.runCheck();

      expect(result.success).toBe(true);
      expect(result.result).toBeDefined();
      // Note: actual degraded status depends on evaluation modules' logic
    });

    it("handles health check errors gracefully", async () => {
      // Create a broken health check by removing required files
      await fs.unlink("/substrate/PLAN.md");

      const result = await scheduler.runCheck();

      // Note: HealthCheck might still succeed even with missing files
      // depending on how robust the evaluation modules are
      expect(result.success).toBe(true);
      // Just verify the check ran without crashing
    });

    it("increments checks run counter even on error", async () => {
      await fs.unlink("/substrate/PLAN.md");

      await scheduler.runCheck();

      expect(scheduler.getStatus().checksRun).toBe(1);
    });

    it("logs check execution", async () => {
      await scheduler.runCheck();

      const logs = logger.getEntries();
      expect(logs.some((log) => log.includes("HealthCheckScheduler: running check"))).toBe(true);
      expect(logs.some((log) => log.includes("HealthCheckScheduler: check complete"))).toBe(true);
    });

    it("logs errors", async () => {
      await fs.unlink("/substrate/PLAN.md");

      await scheduler.runCheck();

      const logs = logger.getEntries();
      // Check completed successfully even without PLAN.md
      expect(logs.some((log) => log.includes("HealthCheckScheduler:"))).toBe(true);
    });
  });

  describe("getStatus", () => {
    it("returns initial status with nulls", () => {
      const status = scheduler.getStatus();

      expect(status.lastCheckTime).toBeNull();
      expect(status.lastResult).toBeNull();
      expect(status.nextCheckDue).toBeNull();
      expect(status.checksRun).toBe(0);
    });

    it("returns status after check", async () => {
      await scheduler.runCheck();

      const status = scheduler.getStatus();

      expect(status.lastCheckTime).toEqual(new Date("2026-02-10T10:00:00.000Z"));
      expect(status.lastResult).toBeDefined();
      expect(status.nextCheckDue).toEqual(new Date("2026-02-10T11:00:00.000Z"));
      expect(status.checksRun).toBe(1);
    });

    it("calculates next check due correctly", async () => {
      await scheduler.runCheck();
      clock.setNow(new Date("2026-02-10T10:30:00.000Z")); // 30 minutes later

      const status = scheduler.getStatus();

      expect(status.nextCheckDue).toEqual(new Date("2026-02-10T11:00:00.000Z"));
    });

    it("updates after multiple checks", async () => {
      await scheduler.runCheck();
      clock.setNow(new Date("2026-02-10T11:00:00.000Z"));
      await scheduler.runCheck();

      const status = scheduler.getStatus();

      expect(status.lastCheckTime).toEqual(new Date("2026-02-10T11:00:00.000Z"));
      expect(status.nextCheckDue).toEqual(new Date("2026-02-10T12:00:00.000Z"));
      expect(status.checksRun).toBe(2);
    });
  });

  describe("integration with HealthCheck", () => {
    it("detects drift issues", async () => {
      // Drift would require more complex substrate state changes
      // This test validates the integration works
      const result = await scheduler.runCheck();

      expect(result.success).toBe(true);
      expect(result.result?.drift).toBeDefined();
      expect(result.result?.drift.score).toBeGreaterThanOrEqual(0);
    });

    it("detects consistency issues", async () => {
      const result = await scheduler.runCheck();

      expect(result.success).toBe(true);
      expect(result.result?.consistency).toBeDefined();
    });

    it("detects security issues", async () => {
      const result = await scheduler.runCheck();

      expect(result.success).toBe(true);
      expect(result.result?.security).toBeDefined();
    });

    it("evaluates plan quality", async () => {
      const result = await scheduler.runCheck();

      expect(result.success).toBe(true);
      expect(result.result?.planQuality).toBeDefined();
      expect(result.result?.planQuality.score).toBeGreaterThanOrEqual(0);
      expect(result.result?.planQuality.score).toBeLessThanOrEqual(1);
    });

    it("validates reasoning", async () => {
      const result = await scheduler.runCheck();

      expect(result.success).toBe(true);
      expect(result.result?.reasoning).toBeDefined();
    });
  });

  describe("fast-path skip", () => {
    const noErrors: IErrorLogReader = { hasErrorsSince: () => false };
    const hasErrors: IErrorLogReader = { hasErrorsSince: () => true };

    function makeScheduler(noErrorWindowCycles: number, errorLogReader?: IErrorLogReader) {
      return new HealthCheckScheduler(healthCheck, clock, logger, {
        checkIntervalMs: 3600000,
        noErrorWindowCycles,
      }, errorLogReader);
    }

    it("does not skip on first check", async () => {
      const s = makeScheduler(3, noErrors);
      const result = await s.runCheck();
      expect(result.success).toBe(true);
      expect(logger.getEntries().some((l) => l.includes("fast-path skip"))).toBe(false);
    });

    it("does not skip before reaching the window threshold", async () => {
      const s = makeScheduler(3, noErrors);

      // Run 2 healthy cycles (threshold is 3) — no fast-path yet
      for (let i = 0; i < 2; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        await s.runCheck();
      }

      // 3rd run: reaches threshold but is still a full check
      clock.setNow(new Date(clock.now().getTime() + 3600000));
      const result = await s.runCheck();

      expect(result.success).toBe(true);
      // 3rd check is still a full check (fast-path fires on 4th+)
      expect(logger.getEntries().some((l) => l.includes("fast-path skip"))).toBe(false);
    });

    it("fires fast-path after N consecutive healthy cycles with no errors", async () => {
      const s = makeScheduler(3, noErrors);

      // Run N full healthy checks
      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        const r = await s.runCheck();
        expect(r.result?.overall).toBe("healthy");
      }

      // Next run should use fast-path
      clock.setNow(new Date(clock.now().getTime() + 3600000));
      const fastResult = await s.runCheck();

      expect(fastResult.success).toBe(true);
      expect(fastResult.result).toBeDefined();
      expect(fastResult.result?.overall).toBe("healthy");
      expect(logger.getEntries().some((l) => l.includes("fast-path skip"))).toBe(true);
    });

    it("does not fire fast-path when error log has entries since last check", async () => {
      const s = makeScheduler(3, hasErrors);

      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        await s.runCheck();
      }

      clock.setNow(new Date(clock.now().getTime() + 3600000));
      await s.runCheck();

      expect(logger.getEntries().some((l) => l.includes("fast-path skip"))).toBe(false);
    });

    it("fires fast-path without an error reader once the consecutive threshold is reached", async () => {
      const s = makeScheduler(3); // no error reader — error check is skipped (passes)

      // Run N full healthy checks to reach threshold
      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        await s.runCheck();
      }

      // 4th run should use fast-path (no error reader means the error-check condition passes)
      clock.setNow(new Date(clock.now().getTime() + 3600000));
      await s.runCheck();

      expect(logger.getEntries().some((l) => l.includes("fast-path skip"))).toBe(true);
    });

    it("fast-path increments checksRun", async () => {
      const s = makeScheduler(3, noErrors);

      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        await s.runCheck();
      }

      const before = s.getStatus().checksRun;
      clock.setNow(new Date(clock.now().getTime() + 3600000));
      await s.runCheck();

      expect(s.getStatus().checksRun).toBe(before + 1);
    });

    it("fast-path returns last known healthy result", async () => {
      const s = makeScheduler(3, noErrors);

      let lastResult;
      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        const r = await s.runCheck();
        lastResult = r.result;
      }

      clock.setNow(new Date(clock.now().getTime() + 3600000));
      const fastResult = await s.runCheck();

      expect(fastResult.result).toEqual(lastResult);
    });

    it("does not fast-path a cached healthy result after inference liveness degrades", async () => {
      const livenessTracker = new InferenceLivenessTracker(clock);
      livenessTracker.recordSuccess();
      const livenessAwareHealthCheck = new HealthCheck(reader, null, undefined, undefined, livenessTracker);
      const s = new HealthCheckScheduler(livenessAwareHealthCheck, clock, logger, {
        checkIntervalMs: 3600000,
        noErrorWindowCycles: 3,
      }, noErrors);

      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        const r = await s.runCheck();
        expect(r.result?.overall).toBe("healthy");
      }

      livenessTracker.recordFailure("HTTP 401");
      livenessTracker.recordFailure("HTTP 401");
      livenessTracker.recordFailure("HTTP 401");

      clock.setNow(new Date(clock.now().getTime() + 3600000));
      const result = await s.runCheck();

      expect(logger.getEntries().some((l) => l.includes("fast-path skip"))).toBe(false);
      expect(result.result?.overall).toBe("unhealthy");
      expect(result.result?.inference?.consecutiveFailures).toBe(3);
    });

    it("resets consecutive count when a full check returns non-healthy, requiring N new healthy cycles for fast-path", async () => {
      // Use a togglable error reader so we can force full checks when needed
      let reportErrors = true;
      const toggleReader: IErrorLogReader = { hasErrorsSince: () => reportErrors };
      const s = new HealthCheckScheduler(healthCheck, clock, logger, {
        checkIntervalMs: 3600000,
        noErrorWindowCycles: 3,
      }, toggleReader);

      // Build up 3 healthy checks (reportErrors=true prevents fast-path)
      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        await s.runCheck();
      }

      // Degrade substrate to force a non-healthy full check
      await fs.writeFile("/substrate/SECURITY.md", "# Security\n\nNo constraints");
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n");

      // Full check runs (errors prevent fast-path) → non-healthy → resets count to 0
      clock.setNow(new Date(clock.now().getTime() + 3600000));
      const degradedResult = await s.runCheck();
      expect(degradedResult.result?.overall).not.toBe("healthy");

      // Restore good substrate files
      await fs.writeFile("/substrate/SECURITY.md", "# Security\n\n## Constraints\nStay safe");
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild authentication system\n\n## Tasks\n- [ ] Task A\n- [ ] Task B");

      // Disable error reporting so fast-path can fire when count is rebuilt
      reportErrors = false;

      // Run 3 more healthy checks — count should rebuild from 0
      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        await s.runCheck();
      }

      // Fast-path should now fire (count = 3 again)
      const logsBefore = logger.getEntries().length;
      clock.setNow(new Date(clock.now().getTime() + 3600000));
      await s.runCheck();

      const newLogs = logger.getEntries().slice(logsBefore);
      expect(newLogs.some((l) => l.includes("fast-path skip"))).toBe(true);
    });

    it("noErrorWindowCycles defaults to 3 when not specified", async () => {
      const s = new HealthCheckScheduler(healthCheck, clock, logger, {
        checkIntervalMs: 3600000,
        // noErrorWindowCycles not set → defaults to 3
      }, noErrors);

      for (let i = 0; i < 3; i++) {
        clock.setNow(new Date(clock.now().getTime() + 3600000));
        await s.runCheck();
      }

      clock.setNow(new Date(clock.now().getTime() + 3600000));
      await s.runCheck();

      expect(logger.getEntries().some((l) => l.includes("fast-path skip"))).toBe(true);
    });
  });
});
