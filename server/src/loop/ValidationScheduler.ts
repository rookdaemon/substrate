import * as path from "node:path";
import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { ILogger } from "../logging";
import { SubstrateValidator, ValidationReport } from "../substrate/validation/SubstrateValidator";
import { PeriodicJobScheduler } from "./PeriodicJobScheduler";

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
  private readonly scheduler: PeriodicJobScheduler<ScheduledValidationResult>;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: ValidationSchedulerConfig
  ) {
    this.scheduler = new PeriodicJobScheduler<ScheduledValidationResult>(
      fs,
      clock,
      logger,
      {
        intervalMs: config.validationIntervalMs,
        stateFilePath: config.stateFilePath,
        name: "ValidationScheduler",
      },
      () => this.doValidation()
    );
  }

  /**
   * Check if validation should run based on interval
   */
  async shouldRunValidation(): Promise<boolean> {
    return this.scheduler.shouldRun();
  }

  /**
   * Execute scheduled validation and append report to PROGRESS.md.
   * Returns a failure result if validation throws; does not update the
   * last-run timestamp so the job is retried on the next cycle.
   */
  async runValidation(): Promise<ScheduledValidationResult> {
    const timestamp = this.clock.now().toISOString();
    try {
      return await this.scheduler.run();
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
    const s = this.scheduler.getStatus();
    return {
      lastValidationTime: s.lastRunTime,
      validationCount: s.runCount,
      nextValidationDue: s.nextDue,
    };
  }

  // ── private ────────────────────────────────────────────────────────────────

  /**
   * Core validation logic.  Throws on error so PeriodicJobScheduler does NOT
   * update the last-run timestamp, ensuring a retry on the next cycle.
   */
  private async doValidation(): Promise<ScheduledValidationResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("ValidationScheduler: starting scheduled substrate validation");

    const validator = new SubstrateValidator(this.fs, this.config.substratePath, this.clock);
    const report = await validator.validate();

    await this.appendReportToProgress(report);

    const overLimitCount = report.eagerReferenceCounts.filter((e) => e.overLimit).length;
    this.logger.debug(
      `ValidationScheduler: complete — ` +
        `${report.brokenReferences.length} broken refs, ` +
        `${report.orphanedFiles.length} orphaned files, ` +
        `${report.staleFiles.length} stale files, ` +
        `${overLimitCount} files over @-reference limit`
    );

    return { success: true, report, timestamp };
  }

  private async appendReportToProgress(report: ValidationReport): Promise<void> {
    const baseDir = this.config.substratePath.replace(/\\/g, "/");
    const progressPath = path.posix.join(baseDir, "PROGRESS.md");
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
