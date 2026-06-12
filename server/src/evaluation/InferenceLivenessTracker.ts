import type { IClock } from "../substrate/abstractions/IClock";

/**
 * Snapshot of inference liveness as of the last recorded attempt.
 */
export interface InferenceLivenessState {
  /** True if the last recorded attempt succeeded (or no failures since last success). */
  alive: boolean;
  /** Number of consecutive failures since the last success. */
  consecutiveFailures: number;
  /** Error text from the most recent failure, if any. */
  lastError?: string;
  /** Wall-clock time of the most recent successful inference. */
  lastSuccessAt: Date | null;
  /** Wall-clock time of the most recent failed inference. */
  lastFailureAt: Date | null;
}

/**
 * Tracks the liveness of the inference path across cycles.
 *
 * Intended use: ProviderFallbackLauncher calls recordSuccess()/recordFailure()
 * after each session attempt. HealthCheck reads getState() to surface
 * inference availability alongside substrate-file checks.
 *
 * This converts the health check from "substrate reads pass" to
 * "substrate reads pass AND inference is reachable", closing the gap that
 * allowed a 401-dead provider to stay invisible for 12 days.
 */
export class InferenceLivenessTracker {
  private consecutiveFailures = 0;
  private lastError?: string;
  private lastSuccessAt: Date | null = null;
  private lastFailureAt: Date | null = null;
  private readonly clock: IClock;

  constructor(clock?: IClock) {
    this.clock = clock ?? { now: () => new Date() };
  }

  /** Call after any successful inference session (primary or fallback). */
  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.lastSuccessAt = this.clock.now();
  }

  /**
   * Call after every failed inference attempt (including when all fallbacks
   * are exhausted).  Auth failures (401) should always call this.
   */
  recordFailure(error: string): void {
    this.consecutiveFailures++;
    this.lastError = error;
    this.lastFailureAt = this.clock.now();
  }

  /** Returns the current liveness state. Cheap: no I/O. */
  getState(): InferenceLivenessState {
    return {
      alive: this.consecutiveFailures === 0,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt,
      lastFailureAt: this.lastFailureAt,
    };
  }

  /**
   * Convenience: returns true if inference looks healthy.
   * @param maxConsecutiveFailures — degrade status after this many sequential failures. Default 3.
   */
  isHealthy(maxConsecutiveFailures = 3): boolean {
    return this.consecutiveFailures < maxConsecutiveFailures;
  }
}
