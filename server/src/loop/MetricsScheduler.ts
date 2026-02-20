import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { ILogger } from "../logging";
import { TaskClassificationMetrics } from "../evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../evaluation/DelegationTracker";
import { SelfImprovementMetricsCollector, PerformanceInput } from "../evaluation/SelfImprovementMetrics";
import * as path from "node:path";

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
  private lastMetricsTime: Date | null = null;
  private metricsCount = 0;
  private stateLoaded = false;

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
  ) {}

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
    // Ensure state is loaded from disk on first call
    if (!this.stateLoaded) {
      await this.ensureStateLoaded();
    }

    if (!this.lastMetricsTime) {
      return true; // First metrics collection
    }

    const elapsed = this.clock.now().getTime() - this.lastMetricsTime.getTime();
    return elapsed >= this.config.metricsIntervalMs;
  }

  /**
   * Execute scheduled metrics collection
   */
  async runMetrics(): Promise<ScheduledMetricsResult> {
    const timestamp = this.clock.now().toISOString();
    this.logger.debug("MetricsScheduler: starting scheduled metrics collection");

    const collected = {
      taskClassifications: false,
      substrateSizes: false,
      delegationRatio: false,
    };

    try {
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
      // In production, this would query GitHub API for issue assignments
      this.logger.debug("MetricsScheduler: delegation ratio collection skipped (requires GitHub API)");

      this.lastMetricsTime = this.clock.now();
      this.metricsCount++;
      this.stateLoaded = true;

      // Persist state after successful collection
      await this.persistLastMetricsTime(this.lastMetricsTime);

      // Run monthly self-improvement metrics if due
      if (this.selfImprovementCollector && this.isSelfImprovementDue()) {
        await this.runSelfImprovement();
      }

      return {
        success: true,
        timestamp,
        collected,
      };
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`MetricsScheduler: metrics collection failed — ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
        timestamp,
        collected,
      };
    }
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

  /**
   * Get scheduler status
   */
  getStatus(): {
    lastMetricsTime: Date | null;
    metricsCount: number;
    nextMetricsDue: Date | null;
  } {
    const nextMetricsDue = this.lastMetricsTime
      ? new Date(this.lastMetricsTime.getTime() + this.config.metricsIntervalMs)
      : this.clock.now();

    return {
      lastMetricsTime: this.lastMetricsTime,
      metricsCount: this.metricsCount,
      nextMetricsDue,
    };
  }

  /**
   * Ensure state is loaded from disk
   */
  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) {
      return;
    }

    this.lastMetricsTime = await this.loadLastMetricsTime();
    this.stateLoaded = true;
  }

  /**
   * Load last metrics time from state file
   */
  private async loadLastMetricsTime(): Promise<Date | null> {
    if (!this.config.stateFilePath) {
      return null;
    }

    try {
      const exists = await this.fs.exists(this.config.stateFilePath);
      if (!exists) {
        return null;
      }

      const content = await this.fs.readFile(this.config.stateFilePath);
      const date = new Date(content.trim());
      return isNaN(date.getTime()) ? null : date;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`MetricsScheduler: failed to load state — ${errorMsg}`);
      return null;
    }
  }

  /**
   * Persist last metrics time to state file
   */
  private async persistLastMetricsTime(time: Date): Promise<void> {
    if (!this.config.stateFilePath) {
      return;
    }

    try {
      const dir = path.dirname(this.config.stateFilePath);
      await this.fs.mkdir(dir, { recursive: true });
      await this.fs.writeFile(this.config.stateFilePath, time.toISOString());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`MetricsScheduler: failed to persist state — ${errorMsg}`);
    }
  }
}
