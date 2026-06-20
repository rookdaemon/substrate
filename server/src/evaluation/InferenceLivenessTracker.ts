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

  /**
   * Three-state health classification that distinguishes "never probed" from
   * "healthy", and (optionally) ages out a tracker whose last success is too old.
   *
   * Additive: this does NOT change alive / getState() / isHealthy(), which remain
   * backward-compatible for ProviderFallbackLauncher and the supervisor's existing
   * pass/fail decision (degraded == >= maxConsecutiveFailures sequential failures).
   *
   * Closes false-GREEN mechanism #3 (the boot-GREEN conflation): alive/isHealthy
   * report "healthy" before any inference has happened (lastSuccessAt === null).
   * getHealthStatus reports "unknown" in that state instead of a false "healthy",
   * so a tracker that has never actually proven the inference path is not counted
   * as live evidence.
   *
   * Staleness is mapped to "unknown" (not "degraded") on purpose: a tracker that
   * simply has no recent success is *absence of fresh evidence*, not evidence of
   * failure. Only confirmed consecutive failures escalate to "degraded" (which the
   * supervisor treats as unhealthy). This keeps the staleness signal from causing a
   * false restart/rollback loop during legitimately quiet stretches.
   *
   * @param maxConsecutiveFailures degrade after this many sequential failures. Default 3.
   * @param maxStalenessMs if provided, a tracker whose last success is older than this
   *        is reported "unknown" rather than "healthy". Omit to disable staleness aging.
   * @returns "degraded" if consecutiveFailures >= maxConsecutiveFailures;
   *          "unknown" if never probed (lastSuccessAt === null) or stale beyond
   *          maxStalenessMs; "healthy" otherwise.
   */
  getHealthStatus(
    maxConsecutiveFailures = 3,
    maxStalenessMs?: number,
  ): "healthy" | "degraded" | "unknown" {
    if (this.consecutiveFailures >= maxConsecutiveFailures) return "degraded";
    if (this.lastSuccessAt === null) return "unknown";
    if (maxStalenessMs !== undefined) {
      const ageMs = this.clock.now().getTime() - this.lastSuccessAt.getTime();
      if (ageMs > maxStalenessMs) return "unknown";
    }
    return "healthy";
  }
}
