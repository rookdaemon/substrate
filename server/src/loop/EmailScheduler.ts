import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { ILogger } from "../logging";
import { toZonedTime, fromZonedTime, formatInTimeZone } from "date-fns-tz";

export interface EmailSchedulerConfig {
  substratePath: string;
  progressFilePath: string;
  emailTime: { hour: number; minute: number }; // Time to send email in CET/CEST
  emailIntervalMs: number; // How often to send emails (e.g., 86400000 for daily)
  recipientEmail?: string; // Optional email recipient
  stateFilePath?: string; // Path to persist last email timestamp
}

export interface EmailContent {
  subject: string;
  body: string;
  timestamp: string;
}

export interface ScheduledEmailResult {
  success: boolean;
  content?: EmailContent;
  error?: string;
  timestamp: string;
}

export interface EmailSchedulerStatus {
  lastEmailTime: Date | null;
  nextEmailDue: Date | null;
  emailsSent: number;
}

export class EmailScheduler {
  private lastEmailTime: Date | null = null;
  private emailsSent = 0;
  private stateLoaded = false;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: EmailSchedulerConfig
  ) {}

  /**
   * Check if an email should be sent based on schedule
   */
  async shouldRunEmail(): Promise<boolean> {
    // Ensure state is loaded from disk on first call
    if (!this.stateLoaded) {
      await this.ensureStateLoaded();
    }

    if (!this.lastEmailTime) {
      return true; // First email
    }

    const now = this.clock.now();
    const nextScheduledTime = this.getNextScheduledTime(this.lastEmailTime);

    return now >= nextScheduledTime;
  }

  /**
   * Execute a scheduled email
   */
  async runEmail(): Promise<ScheduledEmailResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("EmailScheduler: starting scheduled email");

    try {
      // Generate email content
      const content = await this.generateEmailContent();

      if (!content) {
        this.logger.debug("EmailScheduler: failed to generate email content");
        return {
          success: false,
          error: "Failed to generate email content",
          timestamp,
        };
      }

      this.logger.debug(`EmailScheduler: email generated — ${content.subject}`);

      // Update state
      this.lastEmailTime = this.clock.now();
      this.emailsSent++;
      this.stateLoaded = true;

      // Persist state
      await this.persistLastEmailTime(this.lastEmailTime);

      return {
        success: true,
        content,
        timestamp,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`EmailScheduler: unexpected error — ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        timestamp,
      };
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): EmailSchedulerStatus {
    let nextEmailDue: Date | null = null;
    if (this.lastEmailTime) {
      nextEmailDue = this.getNextScheduledTime(this.lastEmailTime);
    } else {
      // If never sent, next email is at the next scheduled time
      nextEmailDue = this.getNextScheduledTime(this.clock.now());
    }

    return {
      lastEmailTime: this.lastEmailTime,
      nextEmailDue,
      emailsSent: this.emailsSent,
    };
  }

  /**
   * Generate email content from PROGRESS.md
   */
  private async generateEmailContent(): Promise<EmailContent | null> {
    try {
      const progressContent = await this.fs.readFile(this.config.progressFilePath);
      const lines = progressContent.split("\n");

      // Extract recent activity - use flexible year regex to match any ISO timestamp
      // Matches ISO timestamps (YYYY-MM-DD), checkmarks, or section headers
      const recentLines = lines.slice(-10).filter(l =>
        l.match(/^(\[\d{4}-\d{2}-\d{2}|- ✅|##)/)
      );

      const now = this.clock.now();
      const dateStr = formatInTimeZone(now, "Europe/Paris", "EEEE, MMMM d, yyyy");

      const subject = `Daily Substrate Update — ${dateStr}`;
      const body = recentLines.length > 0
        ? `Recent Activity:\n\n${recentLines.join("\n")}`
        : "No recent activity recorded.";

      return {
        subject,
        body,
        timestamp: now.toISOString(),
      };
    } catch (err) {
      this.logger.debug(`EmailScheduler: failed to generate content — ${err instanceof Error ? err.message : String(err)}`);
      return null;
    }
  }

  /**
   * Calculate the next scheduled email time after a given date
   */
  private getNextScheduledTime(after: Date): Date {
    // Start with one interval after the last email
    const candidate = new Date(after.getTime() + this.config.emailIntervalMs);
    
    // Convert to Paris timezone to work with local time
    const parisTime = toZonedTime(candidate, "Europe/Paris");
    
    // Set to the scheduled hour/minute
    parisTime.setHours(this.config.emailTime.hour, this.config.emailTime.minute, 0, 0);
    
    // Convert back to UTC
    return fromZonedTime(parisTime, "Europe/Paris");
  }

  /**
   * Load state from disk if stateFilePath is configured
   */
  private async ensureStateLoaded(): Promise<void> {
    if (!this.config.stateFilePath) {
      this.stateLoaded = true;
      return;
    }

    try {
      if (await this.fs.exists(this.config.stateFilePath)) {
        const stateStr = await this.fs.readFile(this.config.stateFilePath);
        const state = JSON.parse(stateStr);
        if (state.lastEmailTime) {
          this.lastEmailTime = new Date(state.lastEmailTime);
          this.emailsSent = state.emailsSent ?? 0;
        }
      }
    } catch (err) {
      this.logger.debug(`EmailScheduler: failed to load state — ${err instanceof Error ? err.message : String(err)}`);
    }
    this.stateLoaded = true;
  }

  /**
   * Persist state to disk
   */
  private async persistLastEmailTime(time: Date): Promise<void> {
    if (!this.config.stateFilePath) {
      return;
    }

    try {
      const state = {
        lastEmailTime: time.toISOString(),
        emailsSent: this.emailsSent,
      };
      await this.fs.writeFile(this.config.stateFilePath, JSON.stringify(state, null, 2));
    } catch (err) {
      this.logger.debug(`EmailScheduler: failed to persist state — ${err instanceof Error ? err.message : String(err)}`);
    }
  }
}
