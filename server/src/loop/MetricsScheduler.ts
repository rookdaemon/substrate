import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { ILogger } from "../logging";
import { TaskClassificationMetrics } from "../evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../evaluation/DelegationTracker";
import { SelfImprovementMetricsCollector, PerformanceInput } from "../evaluation/SelfImprovementMetrics";
import { PeriodicJobScheduler } from "./PeriodicJobScheduler";

export interface MetricsSchedulerConfig {
  substratePath: string;
  metricsIntervalMs: number; // e.g., 604800000 for weekly (7 days)
  stateFilePath?: string; // path to persist last metrics collection timestamp
}

export interface ScheduledMetricsResult {
  success: boolean;
  error?: string;
  timestamp: string;
  collected: {
    taskClassifications: boolean;
    substrateSizes: boolean;
    delegationRatio: boolean;
  };
}

/**
 * Scheduler for periodic metrics collection (weekly).
 *
 * Follows the BackupScheduler pattern:
 * - Time-interval driven (default: weekly)
 * - State persisted to disk for restarts
 * - Coordinates three metrics collectors
 *
 * Integration:
 * - Wire into LoopOrchestrator via setMetricsScheduler()
 * - Called during executeOneCycle() scheduling phase
 * - Runs in background, does not block agent loop
 */
export class MetricsScheduler {
  private readonly scheduler: PeriodicJobScheduler<ScheduledMetricsResult>;

  // Self-improvement metrics (monthly)
  private selfImprovementCollector: SelfImprovementMetricsCollector | null = null;
  private selfImprovementIntervalMs = 30 * 24 * 60 * 60 * 1000; // 30 days
  private lastSelfImprovementTime: Date | null = null;
  private getPerformanceSnapshot: (() => PerformanceInput) | null = null;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: MetricsSchedulerConfig,
    private readonly taskMetrics: TaskClassificationMetrics,
    private readonly sizeTracker: SubstrateSizeTracker,
    private readonly delegationTracker: DelegationTracker
  ) {
    this.scheduler = new PeriodicJobScheduler<ScheduledMetricsResult>(
      fs,
      clock,
      logger,
      {
        intervalMs: config.metricsIntervalMs,
        stateFilePath: config.stateFilePath,
        name: "MetricsScheduler",
      },
      () => this.doMetrics()
    );
  }

  /**
   * Configure optional monthly self-improvement metrics collection.
   * @param collector The SelfImprovementMetricsCollector instance.
   * @param intervalMs Collection interval in ms (default: 30 days).
   * @param getPerformance Optional callback to get current performance data from the orchestrator.
   */
  setSelfImprovementCollector(
    collector: SelfImprovementMetricsCollector,
    intervalMs = 30 * 24 * 60 * 60 * 1000,
    getPerformance?: () => PerformanceInput
  ): void {
    this.selfImprovementCollector = collector;
    this.selfImprovementIntervalMs = intervalMs;
    this.getPerformanceSnapshot = getPerformance ?? null;
  }

  /**
   * Check if metrics collection should run based on interval
   */
  async shouldRunMetrics(): Promise<boolean> {
    return this.scheduler.shouldRun();
  }

  /**
   * Execute scheduled metrics collection
   */
  async runMetrics(): Promise<ScheduledMetricsResult> {
    try {
      return await this.scheduler.run();
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`MetricsScheduler: metrics collection failed — ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        timestamp: this.clock.now().toISOString(),
        collected: { taskClassifications: false, substrateSizes: false, delegationRatio: false },
      };
    }
  }

  /**
   * Get scheduler status
   */
  getStatus(): {
    lastMetricsTime: Date | null;
    metricsCount: number;
    nextMetricsDue: Date | null;
  } {
    const s = this.scheduler.getStatus();
    return {
      lastMetricsTime: s.lastRunTime,
      metricsCount: s.runCount,
      nextMetricsDue: s.nextDue,
    };
  }

  // ── private ────────────────────────────────────────────────────────────────

  /**
   * Core metrics collection logic.
   * Individual collector failures are caught so the overall run still succeeds.
   */
  private async doMetrics(): Promise<ScheduledMetricsResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("MetricsScheduler: starting scheduled metrics collection");

    const collected = {
      taskClassifications: false,
      substrateSizes: false,
      delegationRatio: false,
    };

    // Collect task classification stats (no action needed, just log stats)
    try {
      const stats = await this.taskMetrics.getStats();
      this.logger.debug(
        `MetricsScheduler: task classifications — ${stats.totalOperations} ops, ` +
          `${(stats.tacticalPct * 100).toFixed(1)}% tactical`
      );
      collected.taskClassifications = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`MetricsScheduler: task classification stats failed — ${errorMsg}`);
    }

    // Collect substrate size snapshot
    try {
      await this.sizeTracker.recordSnapshot();
      this.logger.debug("MetricsScheduler: substrate size snapshot recorded");
      collected.substrateSizes = true;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`MetricsScheduler: size snapshot failed — ${errorMsg}`);
    }

    // Collect delegation ratio (placeholder - needs GitHub API integration)
    // For now, skip this as it requires external API calls
    this.logger.debug("MetricsScheduler: delegation ratio collection skipped (requires GitHub API)");

    // Run monthly self-improvement metrics if due
    if (this.selfImprovementCollector && this.isSelfImprovementDue()) {
      await this.runSelfImprovement();
    }

    return { success: true, timestamp, collected };
  }

  /**
   * Whether monthly self-improvement metrics collection is due.
   */
  private isSelfImprovementDue(): boolean {
    if (!this.lastSelfImprovementTime) {
      return true;
    }
    const elapsed = this.clock.now().getTime() - this.lastSelfImprovementTime.getTime();
    return elapsed >= this.selfImprovementIntervalMs;
  }

  /**
   * Run self-improvement metrics collection and save results.
   */
  private async runSelfImprovement(): Promise<void> {
    if (!this.selfImprovementCollector) {
      return;
    }
    try {
      this.logger.debug("MetricsScheduler: collecting monthly self-improvement metrics");
      const perf = this.getPerformanceSnapshot ? this.getPerformanceSnapshot() : {};
      const snapshot = await this.selfImprovementCollector.collect(perf);
      await this.selfImprovementCollector.save(snapshot);
      this.lastSelfImprovementTime = this.clock.now();
      this.logger.debug(
        `MetricsScheduler: self-improvement metrics saved for period ${snapshot.period}`
      );
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`MetricsScheduler: self-improvement metrics failed — ${errorMsg}`);
    }
  }
}
