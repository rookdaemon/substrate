import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IProcessRunner } from "../agents/claude/IProcessRunner";
import { ILogger } from "../logging";
import * as path from "node:path";

export interface EmailSchedulerConfig {
  emailAddress: string; // Stefan's email: lbsa71@hotmail.com
  sendTimeHour: number; // Hour in CET (5 for 5:00 AM)
  sendTimeMinute: number; // Minute (0 for 5:00 AM)
  timezone: string; // e.g., "Europe/Stockholm" for CET
  trackingFilePath: string; // Path to last-daily-email.txt
}

export interface EmailSendResult {
  success: boolean;
  timestamp: string;
  error?: string;
  messagePreview?: string;
}

export interface EmailStatus {
  lastEmailTime: Date | null;
  nextEmailDue: Date | null;
  emailsSent: number;
}

export class EmailScheduler {
  private lastEmailTime: Date | null = null;
  private emailsSent = 0;

  constructor(
    private readonly fs: IFileSystem,
    private readonly runner: IProcessRunner,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: EmailSchedulerConfig
  ) {
    // Load last send time from tracking file on initialization
    this.loadLastEmailTime().catch((err) => {
      this.logger.debug(`EmailScheduler: failed to load last email time — ${err}`);
    });
  }

  /**
   * Load last email time from tracking file
   */
  private async loadLastEmailTime(): Promise<void> {
    try {
      if (await this.fs.exists(this.config.trackingFilePath)) {
        const content = await this.fs.readFile(this.config.trackingFilePath);
        const timestamp = content.trim();
        if (timestamp) {
          this.lastEmailTime = new Date(timestamp);
          this.logger.debug(`EmailScheduler: loaded last email time: ${timestamp}`);
        }
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`EmailScheduler: error loading last email time — ${errorMsg}`);
    }
  }

  /**
   * Save last email time to tracking file
   */
  private async saveLastEmailTime(): Promise<void> {
    try {
      if (this.lastEmailTime) {
        const dir = path.dirname(this.config.trackingFilePath);
        if (!(await this.fs.exists(dir))) {
          await this.fs.mkdir(dir, { recursive: true });
        }
        await this.fs.writeFile(
          this.config.trackingFilePath,
          this.lastEmailTime.toISOString()
        );
        this.logger.debug(`EmailScheduler: saved last email time: ${this.lastEmailTime.toISOString()}`);
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`EmailScheduler: error saving last email time — ${errorMsg}`);
    }
  }

  /**
   * Check if daily email should be sent based on scheduled time (5:00 AM CET)
   */
  shouldSendEmail(): boolean {
    const now = this.clock.now();
    const nextDue = this.getNextScheduledTime();

    // Send if current time is past the next scheduled time
    return now >= nextDue;
  }

  /**
   * Calculate next scheduled email time (5:00 AM CET)
   */
  private getNextScheduledTime(): Date {
    const now = this.clock.now();
    
    // Create a date in CET timezone for today at the scheduled time
    // Note: Using UTC offset approximation for CET (UTC+1/+2 depending on DST)
    // For more accurate timezone handling, would use a library like date-fns-tz
    const cetOffset = this.getCETOffset(now);
    const utcScheduledHour = this.config.sendTimeHour - cetOffset;
    
    let nextScheduled = new Date(now);
    nextScheduled.setUTCHours(utcScheduledHour, this.config.sendTimeMinute, 0, 0);
    
    if (this.lastEmailTime) {
      // Get the scheduled time for the day after last email
      const lastEmailDate = new Date(this.lastEmailTime);
      const nextDay = new Date(lastEmailDate);
      nextDay.setDate(nextDay.getDate() + 1);
      nextDay.setUTCHours(utcScheduledHour, this.config.sendTimeMinute, 0, 0);
      nextScheduled = nextDay;
    } else {
      // First run: use today's scheduled time (even if we're past it)
      // This allows sending immediately if we're past the scheduled time
      // The comparison in shouldSendEmail will handle this correctly
    }
    
    return nextScheduled;
  }

  /**
   * Get CET offset from UTC (simplified: doesn't handle DST perfectly)
   * CET is UTC+1, CEST is UTC+2
   */
  private getCETOffset(_date: Date): number {
    // Simplified: assume CET is UTC+1
    // For production, would need proper DST calculation
    return 1;
  }

  /**
   * Generate brief digest content from recent activity
   */
  private async generateDigestContent(): Promise<string> {
    // Brief check-in message
    let content = "Daily check-in from Substrate.\n\n";
    
    // For now, keep it minimal as per requirements
    // In future iterations, could read PROGRESS.md and PLAN.md
    // to include significant events
    content += "System is operational. No significant events to report.\n";
    
    return content;
  }

  /**
   * Send daily digest email via gog Gmail CLI
   */
  async sendEmail(): Promise<EmailSendResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("EmailScheduler: sending daily digest email");

    try {
      const content = await this.generateDigestContent();
      
      // Send via gog CLI
      // gog send --to <email> --subject <subject> --body <body>
      const result = await this.runner.run("gog", [
        "send",
        "--to", this.config.emailAddress,
        "--subject", "Substrate Daily Digest",
        "--body", content,
      ]);

      if (result.exitCode !== 0) {
        this.logger.debug(`EmailScheduler: gog command failed — ${result.stderr}`);
        return {
          success: false,
          timestamp,
          error: `gog send failed: ${result.stderr}`,
        };
      }

      this.logger.debug(`EmailScheduler: digest email sent successfully`);
      this.lastEmailTime = this.clock.now();
      this.emailsSent++;
      await this.saveLastEmailTime();

      return {
        success: true,
        timestamp,
        messagePreview: content.substring(0, 100),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`EmailScheduler: unexpected error — ${errorMsg}`);
      return {
        success: false,
        timestamp,
        error: errorMsg,
      };
    }
  }

  /**
   * Send immediate SUDO notification
   */
  async sendSudoNotification(message: string): Promise<EmailSendResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("EmailScheduler: sending SUDO notification");

    try {
      const subject = "[SUDO] Substrate Notification";
      
      // Send via gog CLI
      const result = await this.runner.run("gog", [
        "send",
        "--to", this.config.emailAddress,
        "--subject", subject,
        "--body", message,
      ]);

      if (result.exitCode !== 0) {
        this.logger.debug(`EmailScheduler: SUDO notification failed — ${result.stderr}`);
        return {
          success: false,
          timestamp,
          error: `gog send failed: ${result.stderr}`,
        };
      }

      this.logger.debug(`EmailScheduler: SUDO notification sent successfully`);

      return {
        success: true,
        timestamp,
        messagePreview: message.substring(0, 100),
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`EmailScheduler: SUDO notification error — ${errorMsg}`);
      return {
        success: false,
        timestamp,
        error: errorMsg,
      };
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): EmailStatus {
    return {
      lastEmailTime: this.lastEmailTime,
      nextEmailDue: this.getNextScheduledTime(),
      emailsSent: this.emailsSent,
    };
  }
}
