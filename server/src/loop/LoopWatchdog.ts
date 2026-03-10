import { IClock } from "../substrate/abstractions/IClock";
import { ILogger } from "../logging";

export interface LoopWatchdogConfig {
  clock: IClock;
  logger: ILogger;
  injectMessage: (message: string) => void;
  stallThresholdMs: number;
  /** Called when stall persists for forceRestartThresholdMs after the initial reminder. */
  forceRestart?: () => void;
  /** How long after the stall reminder before force-restarting (ms). Only used if forceRestart is set. */
  forceRestartThresholdMs?: number;
}

const STALL_REMINDER =
  `[Watchdog] It's been a while since any progress was logged. ` +
  `This is a gentle reminder: revisit your PLAN.md for pending tasks, ` +
  `and your VALUES.md and ID.md for your drives and goals. ` +
  `If you're blocked, consider updating PLAN.md with what's blocking you ` +
  `and look for an alternative path forward.`;

export class LoopWatchdog {
  private readonly clock: IClock;
  private readonly logger: ILogger;
  private readonly injectMessage: (message: string) => void;
  private readonly stallThresholdMs: number;
  private readonly forceRestart: (() => void) | undefined;
  private readonly forceRestartThresholdMs: number | undefined;

  private lastActivityTime: Date | null = null;
  private reminderSent = false;
  private reminderSentAt: Date | null = null;
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private paused = false;

  constructor(config: LoopWatchdogConfig) {
    this.clock = config.clock;
    this.logger = config.logger;
    this.injectMessage = config.injectMessage;
    this.stallThresholdMs = config.stallThresholdMs;
    this.forceRestart = config.forceRestart;
    this.forceRestartThresholdMs = config.forceRestartThresholdMs;
  }

  recordActivity(): void {
    this.lastActivityTime = this.clock.now();
    this.reminderSent = false;
    this.reminderSentAt = null;
  }

  /** Pause watchdog checks — call when the loop enters SLEEPING state. */
  pause(): void {
    this.paused = true;
    this.logger.debug("watchdog: paused (loop is sleeping)");
  }

  /** Resume watchdog checks — call when the loop wakes. Resets the activity timer. */
  resume(): void {
    this.paused = false;
    this.lastActivityTime = this.clock.now();
    this.reminderSent = false;
    this.reminderSentAt = null;
    this.logger.debug("watchdog: resumed (loop woke)");
  }

  check(): void {
    if (this.paused) {
      return; // No-op while loop is sleeping
    }
    if (!this.lastActivityTime) {
      return;
    }

    const now = this.clock.now();
    const elapsed = now.getTime() - this.lastActivityTime.getTime();

    if (!this.reminderSent) {
      if (elapsed >= this.stallThresholdMs) {
        this.logger.debug(
          `watchdog: no activity for ${Math.round(elapsed / 1000)}s (threshold: ${Math.round(this.stallThresholdMs / 1000)}s) — injecting stall reminder`,
        );
        this.injectMessage(STALL_REMINDER);
        this.reminderSent = true;
        this.reminderSentAt = now;
      }
    } else if (this.forceRestart && this.forceRestartThresholdMs !== undefined && this.forceRestartThresholdMs > 0 && this.reminderSentAt) {
      const timeSinceReminder = now.getTime() - this.reminderSentAt.getTime();
      if (timeSinceReminder >= this.forceRestartThresholdMs) {
        const totalStallSec = Math.round(elapsed / 1000);
        const sinceReminderSec = Math.round(timeSinceReminder / 1000);
        this.logger.debug(
          `watchdog: stall persists ${totalStallSec}s total (${sinceReminderSec}s since reminder) — force restarting`,
        );
        this.forceRestart();
      }
    }
  }

  start(checkIntervalMs: number): void {
    this.stop();
    this.intervalHandle = setInterval(() => this.check(), checkIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  isRunning(): boolean {
    return this.intervalHandle !== null;
  }
}
