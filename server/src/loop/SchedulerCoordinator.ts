import { IScheduler } from "./IScheduler";

/**
 * Holds a collection of schedulers and runs all that are due on each cycle.
 *
 * When `coalesceEnabled` is true (the default), schedulers marked `invokesLlm`
 * are deferred to the next cycle if an LLM session was already started in the
 * current cycle by a cognitive role. Deferred schedulers are guaranteed to run
 * in the next eligible cycle regardless of coalescing (starvation prevention).
 */
export class SchedulerCoordinator {
  private readonly schedulers: IScheduler[];
  private readonly coalesceEnabled: boolean;
  private readonly deferredSchedulers = new Set<IScheduler>();

  constructor(schedulers: IScheduler[], coalesceEnabled = true) {
    this.schedulers = schedulers;
    this.coalesceEnabled = coalesceEnabled;
  }

  /**
   * Check each scheduler in order and run those that are due.
   *
   * @param pendingMessageCount - Number of pending agent messages at the time of the call.
   *   Non-urgent schedulers (urgent=false) are skipped when this is > 0 so that the agent
   *   can process waiting messages in the next cycle without delay from optional background jobs.
   *   Previously-deferred schedulers bypass this check to prevent starvation.
   *
   * @param llmSessionInvokedThisCycle - When true and coalescing is enabled, schedulers
   *   marked `invokesLlm` are deferred to the next cycle to cap LLM usage at one session
   *   per cycle. Schedulers already in the deferred queue run regardless (starvation prevention).
   *
   * Errors thrown by a scheduler's run() propagate immediately and stop
   * subsequent schedulers from executing in this cycle. Callers should
   * ensure individual schedulers handle their own errors where needed.
   */
  async runDueSchedulers(pendingMessageCount = 0, llmSessionInvokedThisCycle = false): Promise<void> {
    for (const scheduler of this.schedulers) {
      const isDeferred = this.deferredSchedulers.has(scheduler);

      // Non-urgent schedulers are skipped when messages are pending,
      // unless they were previously deferred (starvation prevention).
      if (pendingMessageCount > 0 && scheduler.urgent === false && !isDeferred) {
        continue;
      }

      const due = isDeferred || await scheduler.shouldRun();
      if (!due) continue;

      // Coalesce: if an LLM session already ran this cycle and this scheduler invokes
      // LLM, defer it to the next cycle. Schedulers already in the deferred queue are
      // exempt — they must run to prevent starvation.
      if (this.coalesceEnabled && llmSessionInvokedThisCycle && scheduler.invokesLlm && !isDeferred) {
        this.deferredSchedulers.add(scheduler);
        continue;
      }

      this.deferredSchedulers.delete(scheduler);
      await scheduler.run();
    }
  }
}
