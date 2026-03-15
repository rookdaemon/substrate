import { IClock } from "../substrate/abstractions/IClock";
import { ILogger } from "../logging";
import { HealthCheck, HealthCheckResult } from "../evaluation/HealthCheck";
import { PeriodicJobScheduler } from "./PeriodicJobScheduler";

export interface HealthCheckSchedulerConfig {
  checkIntervalMs: number; // How often to run health checks
}

export interface HealthCheckStatus {
  lastCheckTime: Date | null;
  lastResult: HealthCheckResult | null;
  nextCheckDue: Date | null;
  checksRun: number;
}

export class HealthCheckScheduler {
  private readonly scheduler: PeriodicJobScheduler<{ success: boolean; result?: HealthCheckResult; error?: string }>;
  private lastResult: HealthCheckResult | null = null;

  constructor(
    private readonly healthCheck: HealthCheck,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: HealthCheckSchedulerConfig
  ) {
    // No stateFilePath — health check state is in-memory only.
    // PeriodicJobScheduler marks stateLoaded=true immediately so isRunDue() is
    // always valid as a synchronous call.
    this.scheduler = new PeriodicJobScheduler(
      null,
      clock,
      logger,
      { intervalMs: config.checkIntervalMs, name: "HealthCheckScheduler" },
      () => this.doCheck()
    );
  }

  /**
   * Synchronous interval check.  Safe to call without await because health
   * checks have no state file — the interval state is always in-memory.
   */
  shouldRunCheck(): boolean {
    return this.scheduler.isRunDue();
  }

  async runCheck(): Promise<{ success: boolean; result?: HealthCheckResult; error?: string }> {
    const result = await this.scheduler.run();
    if (result.result) {
      this.lastResult = result.result;
    }
    return result;
  }

  getStatus(): HealthCheckStatus {
    const s = this.scheduler.getStatus();
    return {
      lastCheckTime: s.lastRunTime,
      lastResult: this.lastResult,
      // null when no check has ever run (matches original HealthCheckScheduler behaviour)
      nextCheckDue: s.lastRunTime !== null ? s.nextDue : null,
      checksRun: s.runCount,
    };
  }

  // ── private ────────────────────────────────────────────────────────────────

  /**
   * Core health-check logic.  Errors are caught and returned as
   * `{ success: false }` so the scheduler always marks a run (preventing
   * immediate retries on transient failures).
   */
  private async doCheck(): Promise<{ success: boolean; result?: HealthCheckResult; error?: string }> {
    this.logger.debug(`HealthCheckScheduler: running check (check #${this.scheduler.runCount + 1})`);
    try {
      const result = await this.healthCheck.run();
      this.logger.debug(`HealthCheckScheduler: check complete — overall: ${result.overall}`);
      return { success: true, result };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`HealthCheckScheduler: check failed — ${errorMsg}`);
      return { success: false, error: errorMsg };
    }
  }
}
