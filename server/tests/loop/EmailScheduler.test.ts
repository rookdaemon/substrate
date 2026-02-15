import { EmailScheduler } from "../../src/loop/EmailScheduler";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../src/logging";

describe("EmailScheduler", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let logger: InMemoryLogger;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-15T00:00:00.000Z"));
    logger = new InMemoryLogger();
  });

  describe("shouldRunEmail", () => {
    it("should return true on first email", async () => {
      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 }, // 5am CET/CEST
        emailIntervalMs: 86400000, // 24 hours
      });

      expect(await scheduler.shouldRunEmail()).toBe(true);
    });

    it("should return false before interval elapsed", async () => {
      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000, // 24 hours
      });

      // Setup progress file
      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-02-15T10:00:00.000Z] [EGO] Test");

      // Run first email
      await scheduler.runEmail();

      // Advance clock by 12 hours
      clock.setNow(new Date(clock.now().getTime() + 43200000));

      expect(await scheduler.shouldRunEmail()).toBe(false);
    });

    it("should return true after interval elapsed", async () => {
      // Start at 5:30am CET (4:30am UTC in winter)
      clock.setNow(new Date("2026-02-15T04:30:00.000Z"));

      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000, // 24 hours
      });

      // Setup progress file
      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-02-15T10:00:00.000Z] [EGO] Test");

      // Run first email at 5:30am
      await scheduler.runEmail();

      // Advance clock to next day at 5:30am CET (should trigger next email)
      clock.setNow(new Date("2026-02-16T04:30:00.000Z"));

      expect(await scheduler.shouldRunEmail()).toBe(true);
    });
  });

  describe("runEmail", () => {
    it("should generate email successfully", async () => {
      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      // Setup progress file
      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile(
        "/substrate/PROGRESS.md",
        "# Progress\n[2026-02-15T10:00:00.000Z] [EGO] Test entry\n- ✅ Completed task\n## Section"
      );

      const result = await scheduler.runEmail();

      expect(result.success).toBe(true);
      expect(result.content).toBeDefined();
      expect(result.content?.subject).toContain("Daily Substrate Update");
      expect(result.content?.body).toContain("Recent Activity");
      expect(result.error).toBeUndefined();
    });

    it("should handle missing progress file", async () => {
      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      const result = await scheduler.runEmail();

      expect(result.success).toBe(false);
      expect(result.error).toBeDefined();
    });
  });

  describe("getStatus", () => {
    it("should return status with no emails sent", () => {
      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      const status = scheduler.getStatus();

      expect(status.lastEmailTime).toBeNull();
      expect(status.nextEmailDue).not.toBeNull();
      expect(status.emailsSent).toBe(0);
    });

    it("should return status after sending emails", async () => {
      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      // Setup progress file
      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-02-15T10:00:00.000Z] [EGO] Test");

      await scheduler.runEmail();

      const status = scheduler.getStatus();

      expect(status.lastEmailTime).not.toBeNull();
      expect(status.nextEmailDue).not.toBeNull();
      expect(status.emailsSent).toBe(1);
    });
  });

  describe("DST handling", () => {
    describe("CET period (winter, UTC+1)", () => {
      it("should handle January 15, 2026 (CET)", async () => {
        // January 15 is definitely in CET period
        clock.setNow(new Date("2026-01-15T04:00:00.000Z")); // 5am CET = 4am UTC

        const scheduler = new EmailScheduler(fs, clock, logger, {
          substratePath: "/substrate",
          progressFilePath: "/substrate/PROGRESS.md",
          emailTime: { hour: 5, minute: 0 },
          emailIntervalMs: 86400000,
        });

        await fs.mkdir("/substrate", { recursive: true });
        await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-01-15T10:00:00.000Z] [EGO] Winter test");

        const result = await scheduler.runEmail();

        expect(result.success).toBe(true);
        expect(result.content?.subject).toContain("2026");
      });

      it("should handle November 15, 2026 (CET)", async () => {
        // November 15 is in CET period (DST ends last Sunday of October)
        clock.setNow(new Date("2026-11-15T04:00:00.000Z")); // 5am CET = 4am UTC

        const scheduler = new EmailScheduler(fs, clock, logger, {
          substratePath: "/substrate",
          progressFilePath: "/substrate/PROGRESS.md",
          emailTime: { hour: 5, minute: 0 },
          emailIntervalMs: 86400000,
        });

        await fs.mkdir("/substrate", { recursive: true });
        await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-11-15T10:00:00.000Z] [EGO] Late autumn test");

        const result = await scheduler.runEmail();

        expect(result.success).toBe(true);
        expect(result.content?.subject).toContain("2026");
      });
    });

    describe("CEST period (summer, UTC+2)", () => {
      it("should handle June 15, 2026 (CEST)", async () => {
        // June 15 is definitely in CEST period
        clock.setNow(new Date("2026-06-15T03:00:00.000Z")); // 5am CEST = 3am UTC

        const scheduler = new EmailScheduler(fs, clock, logger, {
          substratePath: "/substrate",
          progressFilePath: "/substrate/PROGRESS.md",
          emailTime: { hour: 5, minute: 0 },
          emailIntervalMs: 86400000,
        });

        await fs.mkdir("/substrate", { recursive: true });
        await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-06-15T10:00:00.000Z] [EGO] Summer test");

        const result = await scheduler.runEmail();

        expect(result.success).toBe(true);
        expect(result.content?.subject).toContain("2026");
      });

      it("should handle August 15, 2026 (CEST)", async () => {
        // August 15 is definitely in CEST period
        clock.setNow(new Date("2026-08-15T03:00:00.000Z")); // 5am CEST = 3am UTC

        const scheduler = new EmailScheduler(fs, clock, logger, {
          substratePath: "/substrate",
          progressFilePath: "/substrate/PROGRESS.md",
          emailTime: { hour: 5, minute: 0 },
          emailIntervalMs: 86400000,
        });

        await fs.mkdir("/substrate", { recursive: true });
        await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-08-15T10:00:00.000Z] [EGO] Late summer test");

        const result = await scheduler.runEmail();

        expect(result.success).toBe(true);
        expect(result.content?.subject).toContain("2026");
      });
    });

    describe("DST transition days", () => {
      it("should handle DST start (last Sunday of March 2026)", async () => {
        // March 29, 2026 is the last Sunday of March (DST starts)
        clock.setNow(new Date("2026-03-29T03:00:00.000Z")); // 5am CEST = 3am UTC (after DST switch)

        const scheduler = new EmailScheduler(fs, clock, logger, {
          substratePath: "/substrate",
          progressFilePath: "/substrate/PROGRESS.md",
          emailTime: { hour: 5, minute: 0 },
          emailIntervalMs: 86400000,
        });

        await fs.mkdir("/substrate", { recursive: true });
        await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-03-29T10:00:00.000Z] [EGO] DST start");

        const result = await scheduler.runEmail();

        expect(result.success).toBe(true);
        expect(result.content?.subject).toContain("March");
      });

      it("should handle DST end (last Sunday of October 2026)", async () => {
        // October 25, 2026 is the last Sunday of October (DST ends)
        clock.setNow(new Date("2026-10-25T04:00:00.000Z")); // 5am CET = 4am UTC (after DST ends)

        const scheduler = new EmailScheduler(fs, clock, logger, {
          substratePath: "/substrate",
          progressFilePath: "/substrate/PROGRESS.md",
          emailTime: { hour: 5, minute: 0 },
          emailIntervalMs: 86400000,
        });

        await fs.mkdir("/substrate", { recursive: true });
        await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-10-25T10:00:00.000Z] [EGO] DST end");

        const result = await scheduler.runEmail();

        expect(result.success).toBe(true);
        expect(result.content?.subject).toContain("October");
      });
    });
  });

  describe("Year regex flexibility", () => {
    it("should match timestamps from 2026", async () => {
      clock.setNow(new Date("2026-06-15T03:00:00.000Z"));

      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile(
        "/substrate/PROGRESS.md",
        "# Progress\n[2026-06-15T10:00:00.000Z] [EGO] Entry from 2026"
      );

      const result = await scheduler.runEmail();

      expect(result.success).toBe(true);
      expect(result.content?.body).toContain("2026-06-15");
    });

    it("should match timestamps from 2027", async () => {
      clock.setNow(new Date("2027-06-15T03:00:00.000Z"));

      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile(
        "/substrate/PROGRESS.md",
        "# Progress\n[2027-06-15T10:00:00.000Z] [EGO] Entry from 2027"
      );

      const result = await scheduler.runEmail();

      expect(result.success).toBe(true);
      expect(result.content?.body).toContain("2027-06-15");
    });

    it("should match timestamps from 2030", async () => {
      clock.setNow(new Date("2030-06-15T03:00:00.000Z"));

      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile(
        "/substrate/PROGRESS.md",
        "# Progress\n[2030-06-15T10:00:00.000Z] [EGO] Entry from 2030"
      );

      const result = await scheduler.runEmail();

      expect(result.success).toBe(true);
      expect(result.content?.body).toContain("2030-06-15");
    });

    it("should match timestamps from 2099", async () => {
      clock.setNow(new Date("2099-06-15T03:00:00.000Z"));

      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
      });

      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile(
        "/substrate/PROGRESS.md",
        "# Progress\n[2099-06-15T10:00:00.000Z] [EGO] Entry from 2099"
      );

      const result = await scheduler.runEmail();

      expect(result.success).toBe(true);
      expect(result.content?.body).toContain("2099-06-15");
    });
  });

  describe("State persistence", () => {
    it("should persist state after sending email", async () => {
      const stateFilePath = "/config/email-scheduler-state.json";
      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
        stateFilePath,
      });

      await fs.mkdir("/substrate", { recursive: true });
      await fs.mkdir("/config", { recursive: true });
      await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n[2026-02-15T10:00:00.000Z] [EGO] Test");

      await scheduler.runEmail();

      expect(await fs.exists(stateFilePath)).toBe(true);
      const state = JSON.parse(await fs.readFile(stateFilePath));
      expect(state.lastEmailTime).toBeDefined();
      expect(state.emailsSent).toBe(1);
    });

    it("should load state from disk", async () => {
      const stateFilePath = "/config/email-scheduler-state.json";

      // Pre-populate state file
      await fs.mkdir("/config", { recursive: true });
      await fs.writeFile(
        stateFilePath,
        JSON.stringify({
          lastEmailTime: "2026-02-14T04:00:00.000Z",
          emailsSent: 5,
        })
      );

      const scheduler = new EmailScheduler(fs, clock, logger, {
        substratePath: "/substrate",
        progressFilePath: "/substrate/PROGRESS.md",
        emailTime: { hour: 5, minute: 0 },
        emailIntervalMs: 86400000,
        stateFilePath,
      });

      // State is loaded lazily on first shouldRunEmail call
      await scheduler.shouldRunEmail();

      const statusAfterLoad = scheduler.getStatus();
      expect(statusAfterLoad.lastEmailTime).not.toBeNull();
      expect(statusAfterLoad.emailsSent).toBe(5);
    });
  });
});
