import * as path from "node:path";
import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { ILogger } from "../logging";

export interface PeriodicJobConfig {
  /** How often the job should run (milliseconds). */
  intervalMs: number;
  /** Optional path to persist the last-run timestamp across restarts. */
  stateFilePath?: string;
  /** Name used in log messages (e.g. "BackupScheduler"). */
  name: string;
}

/**
 * Generic scheduler that runs a job at a fixed interval.
 *
 * Extracts the shared boilerplate from BackupScheduler, HealthCheckScheduler,
 * MetricsScheduler, and ValidationScheduler:
 *  - Lazy state loading from an optional state file on first `shouldRun()` call
 *  - Interval-based `shouldRun()` / `isRunDue()` checks
 *  - Persisting the last-run timestamp after each successful run
 *  - Tracking run count
 *
 * When no `stateFilePath` is configured (e.g. HealthCheckScheduler) the state
 * is kept in-memory only and `isRunDue()` is immediately usable as a synchronous
 * check without a prior `shouldRun()` call.
 *
 * Semantics of `run()`:
 *  - Calls the injected job function.
 *  - If the job returns successfully (does not throw), calls `markRan()` to
 *    update state and persist the timestamp.
 *  - If the job throws, the error is re-thrown and state is NOT updated, so the
 *    job will be retried on the next cycle.
 */
export class PeriodicJobScheduler<T> {
  private _lastRunTime: Date | null = null;
  private _runCount = 0;
  private stateLoaded: boolean;

  constructor(
    private readonly fs: IFileSystem | null,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: PeriodicJobConfig,
    private readonly job: () => Promise<T>
  ) {
    // When there is no state file there is nothing to load; treat as already loaded.
    this.stateLoaded = !config.stateFilePath;
  }

  /** Last time the job ran successfully. `null` if it has never run. */
  get lastRunTime(): Date | null {
    return this._lastRunTime;
  }

  /** Total number of successful runs. */
  get runCount(): number {
    return this._runCount;
  }

  /**
   * Async check — loads persisted state on the first call (when a state file is
   * configured) then returns whether the interval has elapsed.
   */
  async shouldRun(): Promise<boolean> {
    if (!this.stateLoaded) {
      await this.ensureStateLoaded();
    }
    return this.isRunDue();
  }

  /**
   * Synchronous check — only safe to call without a prior `shouldRun()` when
   * no `stateFilePath` is configured (state is always in-memory).
   */
  isRunDue(): boolean {
    if (this._lastRunTime === null) return true;
    return this.clock.now().getTime() - this._lastRunTime.getTime() >= this.config.intervalMs;
  }

  /**
   * Execute the job. On success, persists the run timestamp via `markRan()`.
   * On failure (job throws), re-throws without updating state so the job is
   * retried on the next cycle.
   */
  async run(): Promise<T> {
    const result = await this.job();
    await this.markRan(this.clock.now());
    return result;
  }

  /**
   * Record that a run occurred at `time`.  Updates in-memory state and
   * persists to the state file (if configured).  Call this explicitly when
   * callers need fine-grained control over when the run is recorded.
   */
  async markRan(time: Date): Promise<void> {
    this._lastRunTime = time;
    this._runCount++;
    this.stateLoaded = true;
    await this.persistState(time);
  }

  /** Base status fields shared by all periodic jobs. */
  getStatus(): { lastRunTime: Date | null; runCount: number; nextDue: Date | null } {
    const nextDue = this._lastRunTime
      ? new Date(this._lastRunTime.getTime() + this.config.intervalMs)
      : this.clock.now();
    return {
      lastRunTime: this._lastRunTime,
      runCount: this._runCount,
      nextDue,
    };
  }

  // ── private ────────────────────────────────────────────────────────────────

  private async ensureStateLoaded(): Promise<void> {
    if (this.stateLoaded) return;
    this._lastRunTime = await this.loadLastRunTime();
    this.stateLoaded = true;
  }

  private async loadLastRunTime(): Promise<Date | null> {
    if (!this.config.stateFilePath || !this.fs) return null;
    try {
      if (!(await this.fs.exists(this.config.stateFilePath))) return null;
      const content = await this.fs.readFile(this.config.stateFilePath);
      const date = new Date(content.trim());
      return isNaN(date.getTime()) ? null : date;
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`${this.config.name}: failed to load state — ${errorMsg}`);
      return null;
    }
  }

  private async persistState(time: Date): Promise<void> {
    if (!this.config.stateFilePath || !this.fs) return;
    try {
      const dir = path.dirname(this.config.stateFilePath);
      await this.fs.mkdir(dir, { recursive: true });
      await this.fs.writeFile(this.config.stateFilePath, time.toISOString());
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`${this.config.name}: failed to persist state — ${errorMsg}`);
    }
  }
}
