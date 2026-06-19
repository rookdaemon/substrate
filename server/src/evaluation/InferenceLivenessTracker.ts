import type { IClock } from "../substrate/abstractions/IClock";
import type { IFileSystem } from "../substrate/abstractions/IFileSystem";
import type { ILogger } from "../logging";
import * as path from "path";

/**
 * Snapshot of inference liveness as of the last recorded attempt.
 */
export interface InferenceLivenessState {
  /** True if at least one inference attempt has been recorded in this process or loaded from disk. */
  observed: boolean;
  /** True if the last recorded attempt succeeded. False when no attempt has been observed. */
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

interface InferenceLivenessPersistence {
  fs: IFileSystem;
  statePath: string;
  logger?: ILogger;
}

interface PersistedInferenceLivenessState {
  observed?: boolean;
  consecutiveFailures?: number;
  lastError?: string;
  lastSuccessAt?: string | null;
  lastFailureAt?: string | null;
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
  private observed = false;
  private consecutiveFailures = 0;
  private lastError?: string;
  private lastSuccessAt: Date | null = null;
  private lastFailureAt: Date | null = null;
  private readonly clock: IClock;
  private readonly persistence?: InferenceLivenessPersistence;
  private pendingPersist: Promise<void> = Promise.resolve();

  constructor(clock?: IClock, persistence?: InferenceLivenessPersistence) {
    this.clock = clock ?? { now: () => new Date() };
    this.persistence = persistence;
  }

  static async load(clock?: IClock, persistence?: InferenceLivenessPersistence): Promise<InferenceLivenessTracker> {
    const tracker = new InferenceLivenessTracker(clock, persistence);
    await tracker.loadPersistedState();
    return tracker;
  }

  /** Call after any successful inference session (primary or fallback). */
  recordSuccess(): void {
    this.observed = true;
    this.consecutiveFailures = 0;
    this.lastError = undefined;
    this.lastSuccessAt = this.clock.now();
    this.queuePersist();
  }

  /**
   * Call after every failed inference attempt (including when all fallbacks
   * are exhausted).  Auth failures (401) should always call this.
   */
  recordFailure(error: string): void {
    this.observed = true;
    this.consecutiveFailures++;
    this.lastError = error;
    this.lastFailureAt = this.clock.now();
    this.queuePersist();
  }

  /** Returns the current liveness state. Cheap: no I/O. */
  getState(): InferenceLivenessState {
    return {
      observed: this.observed,
      alive: this.observed && this.consecutiveFailures === 0,
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
    return this.observed && this.consecutiveFailures < maxConsecutiveFailures;
  }

  /** Waits for the most recent best-effort persistence write. Used by tests. */
  async flush(): Promise<void> {
    await this.pendingPersist;
  }

  private async loadPersistedState(): Promise<void> {
    if (!this.persistence) return;

    let raw: string;
    try {
      raw = await this.persistence.fs.readFile(this.persistence.statePath);
    } catch {
      // Missing state means no post-start inference signal yet. That is deliberately not healthy.
      return;
    }

    try {
      const parsed = JSON.parse(raw) as PersistedInferenceLivenessState;
      const consecutiveFailures =
        typeof parsed.consecutiveFailures === "number" && Number.isFinite(parsed.consecutiveFailures)
          ? Math.max(0, Math.floor(parsed.consecutiveFailures))
          : 0;
      const lastSuccessAt = parseDateOrNull(parsed.lastSuccessAt);
      const lastFailureAt = parseDateOrNull(parsed.lastFailureAt);
      const observed = parsed.observed === true || consecutiveFailures > 0 || lastSuccessAt !== null || lastFailureAt !== null;

      this.observed = observed;
      this.consecutiveFailures = consecutiveFailures;
      this.lastError = typeof parsed.lastError === "string" ? parsed.lastError : undefined;
      this.lastSuccessAt = lastSuccessAt;
      this.lastFailureAt = lastFailureAt;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.persistence.logger?.warn(`inference-liveness: ignoring unreadable state file: ${message}`);
    }
  }

  private queuePersist(): void {
    if (!this.persistence) return;

    const payload = JSON.stringify({
      observed: this.observed,
      consecutiveFailures: this.consecutiveFailures,
      lastError: this.lastError,
      lastSuccessAt: this.lastSuccessAt?.toISOString() ?? null,
      lastFailureAt: this.lastFailureAt?.toISOString() ?? null,
    }, null, 2);

    const { fs, statePath, logger } = this.persistence;
    this.pendingPersist = this.pendingPersist
      .catch(() => undefined)
      .then(async () => {
        await fs.mkdir(path.dirname(statePath), { recursive: true });
        await fs.writeFile(statePath, payload);
      })
      .catch((err) => {
        const message = err instanceof Error ? err.message : String(err);
        logger?.warn(`inference-liveness: failed to persist state: ${message}`);
      });
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

function parseDateOrNull(value: unknown): Date | null {
  if (typeof value !== "string") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}
