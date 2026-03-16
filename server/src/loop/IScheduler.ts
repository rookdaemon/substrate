/**
 * Common interface for all scheduled tasks.
 * Implementations decide when to run (shouldRun) and how to run (run).
 *
 * Set `urgent = false` on non-critical schedulers (e.g. Metrics, Validation, Health)
 * so they are deferred when pending messages are waiting for the agent to process.
 *
 * Set `invokesLlm = true` on schedulers that start an LLM session (e.g. HealthCheck,
 * Metrics) so they are subject to per-cycle LLM coalescing in SchedulerCoordinator.
 */
export interface IScheduler {
  shouldRun(): Promise<boolean>;
  run(): Promise<void>;
  /** When false, this scheduler is skipped if pending messages are waiting. Default: true. */
  readonly urgent?: boolean;
  /** When true, this scheduler invokes an LLM session and is subject to coalescing. Default: false. */
  readonly invokesLlm?: boolean;
}
