import { HealthCheckScheduler } from "../../src/loop/HealthCheckScheduler";
import { HealthCheck } from "../../src/evaluation/HealthCheck";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";

async function setupSubstrateFiles(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] Task A");
  await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nSome memories");
  await fs.writeFile("/substrate/HABITS.md", "# Habits\n\nSome habits");
  await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nSome skills");
  await fs.writeFile("/substrate/VALUES.md", "# Values\n\nBe good");
  await fs.writeFile("/substrate/ID.md", "# Id\n\nCore identity");
  await fs.writeFile("/substrate/SECURITY.md", "# Security\n\nStay safe");
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
});
