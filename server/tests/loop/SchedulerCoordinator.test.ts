import { SchedulerCoordinator } from "../../src/loop/SchedulerCoordinator";
import { IScheduler } from "../../src/loop/IScheduler";

function makeScheduler(
  shouldRunResult: boolean,
  runFn?: () => Promise<void>,
  options?: { urgent?: boolean; invokesLlm?: boolean },
): IScheduler & { runCalled: boolean } {
  const s = {
    runCalled: false,
    shouldRun: async () => shouldRunResult,
    run: async () => {
      s.runCalled = true;
      if (runFn) await runFn();
    },
    ...options,
  };
  return s;
}

describe("SchedulerCoordinator", () => {
  it("calls run() for schedulers whose shouldRun() returns true", async () => {
    const due = makeScheduler(true);
    const notDue = makeScheduler(false);
    const coordinator = new SchedulerCoordinator([due, notDue]);

    await coordinator.runDueSchedulers();

    expect(due.runCalled).toBe(true);
    expect(notDue.runCalled).toBe(false);
  });

  it("does nothing when no schedulers are registered", async () => {
    const coordinator = new SchedulerCoordinator([]);
    await expect(coordinator.runDueSchedulers()).resolves.toBeUndefined();
  });

  it("runs all due schedulers in order", async () => {
    const order: number[] = [];
    const schedulers = [1, 2, 3].map((n) =>
      makeScheduler(true, async () => { order.push(n); })
    );
    const coordinator = new SchedulerCoordinator(schedulers);

    await coordinator.runDueSchedulers();

    expect(order).toEqual([1, 2, 3]);
  });

  it("skips run() when shouldRun() returns false", async () => {
    const s = makeScheduler(false);
    const coordinator = new SchedulerCoordinator([s]);

    await coordinator.runDueSchedulers();

    expect(s.runCalled).toBe(false);
  });

  it("propagates errors thrown by run()", async () => {
    const failing: IScheduler = {
      shouldRun: async () => true,
      run: async () => { throw new Error("scheduler error"); },
    };
    const coordinator = new SchedulerCoordinator([failing]);

    await expect(coordinator.runDueSchedulers()).rejects.toThrow("scheduler error");
  });

  describe("LLM coalescing", () => {
    it("defers LLM scheduler when llmSessionInvokedThisCycle is true", async () => {
      const llmScheduler = makeScheduler(true, undefined, { invokesLlm: true });
      const coordinator = new SchedulerCoordinator([llmScheduler]);

      await coordinator.runDueSchedulers(0, true);

      expect(llmScheduler.runCalled).toBe(false);
    });

    it("runs LLM scheduler when llmSessionInvokedThisCycle is false", async () => {
      const llmScheduler = makeScheduler(true, undefined, { invokesLlm: true });
      const coordinator = new SchedulerCoordinator([llmScheduler]);

      await coordinator.runDueSchedulers(0, false);

      expect(llmScheduler.runCalled).toBe(true);
    });

    it("runs non-LLM scheduler regardless of llmSessionInvokedThisCycle", async () => {
      const nonLlmScheduler = makeScheduler(true, undefined, { invokesLlm: false });
      const coordinator = new SchedulerCoordinator([nonLlmScheduler]);

      await coordinator.runDueSchedulers(0, true);

      expect(nonLlmScheduler.runCalled).toBe(true);
    });

    it("runs scheduler without invokesLlm regardless of llmSessionInvokedThisCycle", async () => {
      const scheduler = makeScheduler(true);
      const coordinator = new SchedulerCoordinator([scheduler]);

      await coordinator.runDueSchedulers(0, true);

      expect(scheduler.runCalled).toBe(true);
    });

    it("runs deferred LLM scheduler in next cycle even if LLM ran again (starvation prevention)", async () => {
      const llmScheduler = makeScheduler(true, undefined, { invokesLlm: true });
      const coordinator = new SchedulerCoordinator([llmScheduler]);

      // Cycle 1: LLM ran — scheduler is deferred
      await coordinator.runDueSchedulers(0, true);
      expect(llmScheduler.runCalled).toBe(false);

      // Cycle 2: LLM ran again — deferred scheduler must run regardless
      await coordinator.runDueSchedulers(0, true);
      expect(llmScheduler.runCalled).toBe(true);
    });

    it("clears deferred state after running a deferred scheduler", async () => {
      const llmScheduler = makeScheduler(true, undefined, { invokesLlm: true });
      const coordinator = new SchedulerCoordinator([llmScheduler]);

      // Cycle 1: deferred
      await coordinator.runDueSchedulers(0, true);
      expect(llmScheduler.runCalled).toBe(false);

      // Cycle 2: runs (starvation prevention)
      await coordinator.runDueSchedulers(0, true);
      expect(llmScheduler.runCalled).toBe(true);

      // Reset and check that it's no longer force-deferred
      llmScheduler.runCalled = false;

      // Cycle 3: shouldRun returns true, no LLM ran — should run normally
      await coordinator.runDueSchedulers(0, false);
      expect(llmScheduler.runCalled).toBe(true);
    });

    it("deferred LLM scheduler bypasses pending message check", async () => {
      const llmScheduler = makeScheduler(true, undefined, { invokesLlm: true, urgent: false });
      const coordinator = new SchedulerCoordinator([llmScheduler]);

      // Cycle 1: deferred due to LLM coalescing
      await coordinator.runDueSchedulers(0, true);
      expect(llmScheduler.runCalled).toBe(false);

      // Cycle 2: pending messages present AND LLM ran again,
      // but deferred scheduler must run (starvation prevention overrides both checks)
      await coordinator.runDueSchedulers(5, true);
      expect(llmScheduler.runCalled).toBe(true);
    });

    it("disabling coalescing runs LLM schedulers immediately", async () => {
      const llmScheduler = makeScheduler(true, undefined, { invokesLlm: true });
      const coordinator = new SchedulerCoordinator([llmScheduler], false);

      await coordinator.runDueSchedulers(0, true);

      expect(llmScheduler.runCalled).toBe(true);
    });

    it("runs non-LLM and LLM schedulers independently", async () => {
      const nonLlmScheduler = makeScheduler(true, undefined, { invokesLlm: false });
      const llmScheduler = makeScheduler(true, undefined, { invokesLlm: true });
      const coordinator = new SchedulerCoordinator([nonLlmScheduler, llmScheduler]);

      await coordinator.runDueSchedulers(0, true);

      expect(nonLlmScheduler.runCalled).toBe(true);
      expect(llmScheduler.runCalled).toBe(false);
    });
  });
});
