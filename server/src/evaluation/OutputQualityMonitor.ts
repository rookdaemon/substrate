import type { IClock } from "../substrate/abstractions/IClock";
import type { EndorsementSessionStats } from "../agents/endorsement/EndorsementInterceptor";

/**
 * Snapshot of output quality as of the last recorded cycle.
 */
export interface OutputQualityState {
  /** True if no degradation detected (or no signal yet). */
  healthy: boolean;
  /** Number of consecutive degraded cycles observed. */
  consecutiveDegradedCycles: number;
  /** Human-readable reason for the most recent degraded cycle, if any. */
  lastDegradedReason?: string;
  /** Wall-clock time of the last healthy cycle. */
  lastHealthyAt: Date | null;
  /** Wall-clock time of the last degraded cycle. */
  lastDegradedAt: Date | null;
}

/**
 * Tracks output quality of the Ego/Subconscious inference path across cycles.
 *
 * Intended use: LoopOrchestrator feeds per-cycle EndorsementSessionStats after
 * each endorsement check. OutputQualityMonitor detects the parse-error storm
 * pattern — where a degraded model emits template placeholders or causes the
 * screener to fail parsing repeatedly — before it becomes a crash-loop event.
 *
 * Degradation signals (either triggers a degraded cycle):
 *   1. screener parse-error: EndorsementScreener returned matchedSection === "parse-error"
 *   2. placeholder action: action text matched a template placeholder (e.g. "<brief description>")
 *
 * Only cycles where totalChecks > 0 carry meaningful signal. Callers should
 * skip recordCycleStats() when totalChecks === 0.
 */
export class OutputQualityMonitor {
  private consecutiveDegradedCycles = 0;
  private lastDegradedReason?: string;
  private lastHealthyAt: Date | null = null;
  private lastDegradedAt: Date | null = null;
  private readonly clock: IClock;

  constructor(clock?: IClock) {
    this.clock = clock ?? { now: () => new Date() };
  }

  /**
   * Record the endorsement stats for a completed cycle.
   * Should only be called when stats.totalChecks > 0 (i.e. endorsement fired).
   */
  recordCycleStats(stats: EndorsementSessionStats): void {
    const isDegraded = stats.parseErrors > 0 || stats.placeholderActions > 0;
    if (isDegraded) {
      this.consecutiveDegradedCycles++;
      this.lastDegradedAt = this.clock.now();
      if (stats.parseErrors > 0) {
        this.lastDegradedReason = `screener parse-error (${stats.parseErrors} of ${stats.totalChecks} checks)`;
      } else {
        this.lastDegradedReason = `placeholder action detected (${stats.placeholderActions} of ${stats.totalChecks} checks)`;
      }
    } else {
      this.consecutiveDegradedCycles = 0;
      this.lastDegradedReason = undefined;
      this.lastHealthyAt = this.clock.now();
    }
  }

  /** Returns the current output quality state. Cheap: no I/O. */
  getState(): OutputQualityState {
    return {
      healthy: this.consecutiveDegradedCycles === 0,
      consecutiveDegradedCycles: this.consecutiveDegradedCycles,
      lastDegradedReason: this.lastDegradedReason,
      lastHealthyAt: this.lastHealthyAt,
      lastDegradedAt: this.lastDegradedAt,
    };
  }

  /**
   * Convenience: returns true if output quality looks healthy.
   * @param maxConsecutiveDegradedCycles — degrade status after this many sequential bad cycles. Default 3.
   */
  isHealthy(maxConsecutiveDegradedCycles = 3): boolean {
    return this.consecutiveDegradedCycles < maxConsecutiveDegradedCycles;
  }
}
