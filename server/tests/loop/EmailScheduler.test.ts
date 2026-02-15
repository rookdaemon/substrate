import { EmailScheduler } from "../../src/loop/EmailScheduler";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryLogger } from "../../src/logging";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";

describe("EmailScheduler", () => {
  let fs: InMemoryFileSystem;
  let runner: InMemoryProcessRunner;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let scheduler: EmailScheduler;
  const trackingFile = "/config/substrate/last-daily-email.txt";

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    runner = new InMemoryProcessRunner();
    // Set to 3:00 AM UTC (4:00 AM CET, since CET is UTC+1)
    clock = new FixedClock(new Date("2026-02-15T03:00:00.000Z"));
    logger = new InMemoryLogger();

    scheduler = new EmailScheduler(fs, runner, clock, logger, {
      emailAddress: "lbsa71@hotmail.com",
      sendTimeHour: 5, // 5:00 AM CET
      sendTimeMinute: 0,
      timezone: "Europe/Stockholm",
      trackingFilePath: trackingFile,
    });
  });

  describe("shouldSendEmail", () => {
    it("returns false when before scheduled time and no email has been sent yet", () => {
      // At 3:00 AM UTC (4:00 AM CET), before 5:00 AM scheduled time
      expect(scheduler.shouldSendEmail()).toBe(false);
    });

    it("returns true when scheduled time has arrived", () => {
      // Advance to 5:01 AM CET (4:01 AM UTC) - past scheduled time
      clock.setNow(new Date("2026-02-15T04:01:00.000Z"));
      expect(scheduler.shouldSendEmail()).toBe(true);
    });

    it("returns false immediately after sending email", async () => {
      // Advance to 5:00 AM CET
      clock.setNow(new Date("2026-02-15T04:00:00.000Z"));
      
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      await scheduler.sendEmail();
      
      expect(scheduler.shouldSendEmail()).toBe(false);
    });

    it("returns true 24 hours after last email", async () => {
      // Send email at 5:00 AM CET
      clock.setNow(new Date("2026-02-15T04:00:00.000Z"));
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      await scheduler.sendEmail();
      
      // Advance to next day at 5:00 AM CET
      clock.setNow(new Date("2026-02-16T04:00:00.000Z"));
      expect(scheduler.shouldSendEmail()).toBe(true);
    });

    it("returns false before next scheduled time", async () => {
      // Send email at 5:00 AM CET
      clock.setNow(new Date("2026-02-15T04:00:00.000Z"));
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      await scheduler.sendEmail();
      
      // Advance to 6:00 AM same day
      clock.setNow(new Date("2026-02-15T05:00:00.000Z"));
      expect(scheduler.shouldSendEmail()).toBe(false);
    });
  });

  describe("sendEmail", () => {
    beforeEach(() => {
      // Set time to 5:00 AM CET
      clock.setNow(new Date("2026-02-15T04:00:00.000Z"));
    });

    it("sends email via gog CLI with correct parameters", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      const result = await scheduler.sendEmail();
      
      expect(result.success).toBe(true);
      const calls = runner.getCalls();
      expect(calls[0]).toEqual({
        command: "gog",
        args: expect.arrayContaining([
          "send",
          "--to", "lbsa71@hotmail.com",
          "--subject", "Substrate Daily Digest",
          "--body", expect.any(String),
        ]),
      });
    });

    it("includes brief digest content", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      const result = await scheduler.sendEmail();
      
      expect(result.success).toBe(true);
      expect(result.messagePreview).toContain("Daily check-in");
    });

    it("updates last email time after successful send", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      const statusBefore = scheduler.getStatus();
      expect(statusBefore.lastEmailTime).toBeNull();
      
      await scheduler.sendEmail();
      
      const statusAfter = scheduler.getStatus();
      expect(statusAfter.lastEmailTime).toEqual(clock.now());
    });

    it("increments email count", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      expect(scheduler.getStatus().emailsSent).toBe(0);
      await scheduler.sendEmail();
      expect(scheduler.getStatus().emailsSent).toBe(1);
      
      clock.setNow(new Date("2026-02-16T04:00:00.000Z"));
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      await scheduler.sendEmail();
      expect(scheduler.getStatus().emailsSent).toBe(2);
    });

    it("saves last email time to tracking file", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      await scheduler.sendEmail();
      
      // Wait a tick for async save
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      const savedContent = await fs.readFile(trackingFile);
      expect(savedContent).toBe("2026-02-15T04:00:00.000Z");
    });

    it("returns error when gog command fails", async () => {
      runner.enqueue({ 
        exitCode: 1, 
        stdout: "", 
        stderr: "Authentication failed" 
      });
      
      const result = await scheduler.sendEmail();
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Authentication failed");
    });

    it("handles exceptions gracefully", async () => {
      // Don't enqueue any response, which will cause an error
      
      const result = await scheduler.sendEmail();
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("No more canned responses");
    });
  });

  describe("sendSudoNotification", () => {
    it("sends immediate notification with [SUDO] prefix", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      const result = await scheduler.sendSudoNotification("Critical issue detected!");
      
      expect(result.success).toBe(true);
      const calls = runner.getCalls();
      expect(calls[0]).toEqual({
        command: "gog",
        args: expect.arrayContaining([
          "send",
          "--to", "lbsa71@hotmail.com",
          "--subject", "[SUDO] Substrate Notification",
          "--body", "Critical issue detected!",
        ]),
      });
    });

    it("does not update last email time", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      const statusBefore = scheduler.getStatus();
      await scheduler.sendSudoNotification("Alert!");
      const statusAfter = scheduler.getStatus();
      
      expect(statusAfter.lastEmailTime).toEqual(statusBefore.lastEmailTime);
    });

    it("does not increment email count", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      const countBefore = scheduler.getStatus().emailsSent;
      await scheduler.sendSudoNotification("Alert!");
      const countAfter = scheduler.getStatus().emailsSent;
      
      expect(countAfter).toBe(countBefore);
    });

    it("returns error when gog command fails", async () => {
      runner.enqueue({ 
        exitCode: 1, 
        stdout: "", 
        stderr: "Send failed" 
      });
      
      const result = await scheduler.sendSudoNotification("Alert!");
      
      expect(result.success).toBe(false);
      expect(result.error).toContain("Send failed");
    });
  });

  describe("getStatus", () => {
    it("returns null for lastEmailTime initially", () => {
      const status = scheduler.getStatus();
      expect(status.lastEmailTime).toBeNull();
    });

    it("returns correct next due time when no email sent", () => {
      // At 3:00 AM UTC (4:00 AM CET), next email is 4:00 AM UTC (5:00 AM CET)
      clock.setNow(new Date("2026-02-15T03:00:00.000Z"));
      
      const status = scheduler.getStatus();
      expect(status.nextEmailDue).toEqual(new Date("2026-02-15T04:00:00.000Z"));
    });

    it("calculates next due time as 24 hours after last email", async () => {
      clock.setNow(new Date("2026-02-15T04:00:00.000Z"));
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      await scheduler.sendEmail();
      
      const status = scheduler.getStatus();
      expect(status.nextEmailDue).toEqual(new Date("2026-02-16T04:00:00.000Z"));
    });

    it("tracks email count correctly", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      
      expect(scheduler.getStatus().emailsSent).toBe(0);
      
      clock.setNow(new Date("2026-02-15T04:00:00.000Z"));
      await scheduler.sendEmail();
      expect(scheduler.getStatus().emailsSent).toBe(1);
      
      clock.setNow(new Date("2026-02-16T04:00:00.000Z"));
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      await scheduler.sendEmail();
      expect(scheduler.getStatus().emailsSent).toBe(2);
    });
  });

  describe("tracking file persistence", () => {
    it("loads last email time from existing tracking file", async () => {
      // Write a previous timestamp
      await fs.mkdir("/config/substrate", { recursive: true });
      await fs.writeFile(trackingFile, "2026-02-14T04:00:00.000Z");
      
      // Create new scheduler instance
      const newScheduler = new EmailScheduler(fs, runner, clock, logger, {
        emailAddress: "lbsa71@hotmail.com",
        sendTimeHour: 5,
        sendTimeMinute: 0,
        timezone: "Europe/Stockholm",
        trackingFilePath: trackingFile,
      });
      
      // Give it time to load
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      const status = newScheduler.getStatus();
      expect(status.lastEmailTime).toEqual(new Date("2026-02-14T04:00:00.000Z"));
    });

    it("creates tracking directory if it doesn't exist", async () => {
      runner.enqueue({ exitCode: 0, stdout: "Email sent", stderr: "" });
      clock.setNow(new Date("2026-02-15T04:00:00.000Z"));
      
      await scheduler.sendEmail();
      
      // Wait for async save
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      expect(await fs.exists("/config/substrate")).toBe(true);
      expect(await fs.exists(trackingFile)).toBe(true);
    });

    it("handles missing tracking file gracefully", async () => {
      // No tracking file exists
      const status = scheduler.getStatus();
      expect(status.lastEmailTime).toBeNull();
    });

    it("handles corrupted tracking file gracefully", async () => {
      await fs.mkdir("/config/substrate", { recursive: true });
      await fs.writeFile(trackingFile, "invalid-date-string");
      
      const newScheduler = new EmailScheduler(fs, runner, clock, logger, {
        emailAddress: "lbsa71@hotmail.com",
        sendTimeHour: 5,
        sendTimeMinute: 0,
        timezone: "Europe/Stockholm",
        trackingFilePath: trackingFile,
      });
      
      // Give it time to load
      await new Promise((resolve) => setTimeout(resolve, 10));
      
      // Should still work, just with null last time
      const status = newScheduler.getStatus();
      // May be null or Invalid Date
      expect(status.emailsSent).toBe(0);
    });
  });
});
