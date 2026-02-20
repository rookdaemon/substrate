import * as path from "node:path";
import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { ILogger } from "../logging";
import { SubstrateValidator, ValidationReport } from "../substrate/validation/SubstrateValidator";

export interface ValidationSchedulerConfig {
  substratePath: string;
  validationIntervalMs: number; // e.g., 604800000 for weekly (7 days)
  stateFilePath?: string; // path to persist last validation timestamp
}

export interface ScheduledValidationResult {
  success: boolean;
  report?: ValidationReport;
  error?: string;
  timestamp: string;
}

/**
 * Scheduler for periodic substrate validation (weekly by default).
 *
 * Follows the MetricsScheduler pattern:
 * - Time-interval driven (default: weekly)
 * - State persisted to disk for restarts
 * - Runs SubstrateValidator and appends JSON report to PROGRESS.md
 *
 * Integration:
 * - Wire into LoopOrchestrator via setValidationScheduler()
 * - Called during executeOneCycle() scheduling phase
 */
export class ValidationScheduler {
  private lastValidationTime: Date | null = null;
  private validationCount = 0;
  private stateLoaded = false;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: ValidationSchedulerConfig
  ) {}

  /**
   * Check if validation should run based on interval
   */
  async shouldRunValidation(): Promise<boolean> {
    if (!this.stateLoaded) {
      await this.ensureStateLoaded();
    }

    if (!this.lastValidationTime) {
      return true; // First validation
    }

    const elapsed = this.clock.now().getTime() - this.lastValidationTime.getTime();
    return elapsed >= this.config.validationIntervalMs;
  }

  /**
   * Execute scheduled validation and append report to PROGRESS.md
   */
  async runValidation(): Promise<ScheduledValidationResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("ValidationScheduler: starting scheduled substrate validation");

    try {
      const validator = new SubstrateValidator(this.fs, this.config.substratePath, this.clock);
      const report = await validator.validate();

      this.lastValidationTime = this.clock.now();
      this.validationCount++;
      this.stateLoaded = true;

      await this.persistLastValidationTime(this.lastValidationTime);
      await this.appendReportToProgress(report);

      this.logger.debug(
        `ValidationScheduler: complete — ` +
          `${report.brokenReferences.length} broken refs, ` +
          `${report.orphanedFiles.length} orphaned files, ` +
          `${report.staleFiles.length} stale files`
      );

      return { success: true, report, timestamp };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`ValidationScheduler: validation failed — ${errorMsg}`);
      return { success: false, error: errorMsg, timestamp };
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    lastValidationTime: Date | null;
    validationCount: number;
    nextValidationDue: Date | null;
  } {
    const nextValidationDue = this.lastValidationTime
      ? new Date(this.lastValidationTime.getTime() + this.config.validationIntervalMs)
      : this.clock.now();

    return {
      lastValidationTime: this.lastValidationTime,
      validationCount: this.validationCount,
      nextValidationDue,
    };
  }

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) {
      return;
    }
    this.lastValidationTime = await this.loadLastValidationTime();
    this.stateLoaded = true;
  }

  private async loadLastValidationTime(): Promise<Date | null> {
    if (!this.config.stateFilePath) {
      return null;
    }

    try {
      if (!(await this.fs.exists(this.config.stateFilePath))) {
        return null;
      }
      const content = await this.fs.readFile(this.config.stateFilePath);
      const date = new Date(content.trim());
      return isNaN(date.getTime()) ? null : date;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`ValidationScheduler: failed to load state — ${errorMsg}`);
      return null;
    }
  }

  private async persistLastValidationTime(time: Date): Promise<void> {
    if (!this.config.stateFilePath) {
      return;
    }

    try {
      const dir = path.dirname(this.config.stateFilePath);
      await this.fs.mkdir(dir, { recursive: true });
      await this.fs.writeFile(this.config.stateFilePath, time.toISOString());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`ValidationScheduler: failed to persist state — ${errorMsg}`);
    }
  }

  private async appendReportToProgress(report: ValidationReport): Promise<void> {
    const progressPath = path.join(this.config.substratePath, "PROGRESS.md");
    if (!(await this.fs.exists(progressPath))) {
      return;
    }

    const entry =
      `\n## Substrate Validation Report (${report.timestamp})\n\n` +
      `\`\`\`json\n${JSON.stringify(report, null, 2)}\n\`\`\`\n`;

    try {
      await this.fs.appendFile(progressPath, entry);
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`ValidationScheduler: failed to append report to PROGRESS.md — ${errorMsg}`);
    }
  }
}
