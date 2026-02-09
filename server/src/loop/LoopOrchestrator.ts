import { Ego } from "../agents/roles/Ego";
import { Subconscious } from "../agents/roles/Subconscious";
import { Superego } from "../agents/roles/Superego";
import { Id } from "../agents/roles/Id";
import { ProcessLogEntry } from "../agents/claude/StreamJsonParser";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { IClock } from "../substrate/abstractions/IClock";
import { ILogger } from "../logging";
import { ITimer } from "./ITimer";
import { ILoopEventSink } from "./ILoopEventSink";
import { IdleHandler } from "./IdleHandler";
import {
  LoopState,
  LoopConfig,
  CycleResult,
  LoopMetrics,
  createInitialMetrics,
} from "./types";

export class LoopOrchestrator {
  private state: LoopState = LoopState.STOPPED;
  private metrics: LoopMetrics = createInitialMetrics();
  private cycleNumber = 0;
  private isProcessing = false;

  private auditOnNextCycle = false;

  constructor(
    private readonly ego: Ego,
    private readonly subconscious: Subconscious,
    private readonly superego: Superego,
    private readonly _id: Id,
    private readonly _appendWriter: AppendOnlyWriter,
    private readonly clock: IClock,
    private readonly timer: ITimer,
    private readonly eventSink: ILoopEventSink,
    private readonly config: LoopConfig,
    private readonly logger: ILogger,
    private readonly idleHandler?: IdleHandler
  ) {}

  getState(): LoopState {
    return this.state;
  }

  getMetrics(): LoopMetrics {
    return { ...this.metrics };
  }

  start(): void {
    if (this.state !== LoopState.STOPPED) {
      throw new Error(`Cannot start: loop is in ${this.state} state`);
    }
    this.logger.debug("start() called");
    this.transition(LoopState.RUNNING);
  }

  pause(): void {
    if (this.state !== LoopState.RUNNING) {
      throw new Error(`Cannot pause: loop is in ${this.state} state`);
    }
    this.logger.debug("pause() called");
    this.transition(LoopState.PAUSED);
  }

  resume(): void {
    if (this.state !== LoopState.PAUSED) {
      throw new Error(`Cannot resume: loop is in ${this.state} state`);
    }
    this.logger.debug("resume() called");
    this.transition(LoopState.RUNNING);
  }

  stop(): void {
    if (this.state === LoopState.STOPPED) {
      return;
    }
    this.logger.debug("stop() called");
    this.transition(LoopState.STOPPED);
  }

  requestAudit(): void {
    this.auditOnNextCycle = true;
    this.eventSink.emit({
      type: "evaluation_requested",
      timestamp: this.clock.now().toISOString(),
      data: {},
    });
  }

  async runOneCycle(): Promise<CycleResult> {
    if (this.isProcessing) {
      this.logger.debug("runOneCycle() skipped — already processing");
      return {
        cycleNumber: this.cycleNumber,
        action: "idle",
        success: true,
        summary: "Skipped — cycle already in progress",
      };
    }

    this.isProcessing = true;
    try {
      return await this.executeOneCycle();
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeOneCycle(): Promise<CycleResult> {
    this.cycleNumber++;
    this.metrics.totalCycles++;

    this.logger.debug(`cycle ${this.cycleNumber}: starting`);

    const dispatch = await this.ego.dispatchNext();

    let result: CycleResult;

    if (!dispatch) {
      this.metrics.idleCycles++;
      this.metrics.consecutiveIdleCycles++;

      this.logger.debug(`cycle ${this.cycleNumber}: idle (consecutive: ${this.metrics.consecutiveIdleCycles})`);

      result = {
        cycleNumber: this.cycleNumber,
        action: "idle",
        success: true,
        summary: "No tasks available — idle",
      };

      this.eventSink.emit({
        type: "idle",
        timestamp: this.clock.now().toISOString(),
        data: { consecutiveIdleCycles: this.metrics.consecutiveIdleCycles },
      });
    } else {
      this.logger.debug(`cycle ${this.cycleNumber}: dispatching task "${dispatch.taskId}"`);

      const taskResult = await this.subconscious.execute({
        taskId: dispatch.taskId,
        description: dispatch.description,
      }, this.createLogCallback("SUBCONSCIOUS"));

      const success = taskResult.result === "success";

      this.logger.debug(`cycle ${this.cycleNumber}: task "${dispatch.taskId}" ${success ? "succeeded" : "failed"} — ${taskResult.summary}`);

      if (success) {
        this.metrics.successfulCycles++;
        this.metrics.consecutiveIdleCycles = 0;

        await this.subconscious.markTaskComplete(dispatch.taskId);

        if (taskResult.progressEntry) {
          await this.subconscious.logProgress(taskResult.progressEntry);
        }

        if (taskResult.skillUpdates) {
          await this.subconscious.updateSkills(taskResult.skillUpdates);
        }

        if (taskResult.summary) {
          await this.subconscious.logConversation(taskResult.summary);
        }
      } else {
        this.metrics.failedCycles++;
      }

      if (taskResult.proposals.length > 0) {
        this.logger.debug(`cycle ${this.cycleNumber}: evaluating ${taskResult.proposals.length} proposal(s)`);
        await this.superego.evaluateProposals(taskResult.proposals, this.createLogCallback("SUPEREGO"));
      }

      result = {
        cycleNumber: this.cycleNumber,
        action: "dispatch",
        taskId: dispatch.taskId,
        success,
        summary: taskResult.summary,
      };
    }

    this.eventSink.emit({
      type: "cycle_complete",
      timestamp: this.clock.now().toISOString(),
      data: { cycleNumber: this.cycleNumber, action: result.action },
    });

    // Superego audit scheduling
    if (this.cycleNumber % this.config.superegoAuditInterval === 0 || this.auditOnNextCycle) {
      this.auditOnNextCycle = false;
      await this.runAudit();
    }

    return result;
  }

  async runLoop(): Promise<void> {
    this.logger.debug("runLoop() entered");
    while (this.state === LoopState.RUNNING) {
      await this.runOneCycle();

      if (this.metrics.consecutiveIdleCycles >= this.config.maxConsecutiveIdleCycles) {
        if (this.idleHandler) {
          this.logger.debug(`runLoop: idle threshold reached (${this.metrics.consecutiveIdleCycles}), invoking IdleHandler`);
          const result = await this.idleHandler.handleIdle((role) => this.createLogCallback(role));
          this.logger.debug(`runLoop: IdleHandler result: ${result.action} (goalCount: ${result.goalCount ?? 0})`);
          this.eventSink.emit({
            type: "idle_handler",
            timestamp: this.clock.now().toISOString(),
            data: { action: result.action, goalCount: result.goalCount },
          });
          if (result.action === "plan_created") {
            this.metrics.consecutiveIdleCycles = 0;
            continue;
          }
        }
        this.logger.debug("runLoop: stopping — idle threshold exceeded with no plan created");
        this.stop();
        break;
      }

      if (this.state !== LoopState.RUNNING) {
        this.logger.debug(`runLoop: exiting — state is ${this.state}`);
        break;
      }

      this.logger.debug(`runLoop: delaying ${this.config.cycleDelayMs}ms before next cycle`);
      await this.timer.delay(this.config.cycleDelayMs);
    }
    this.logger.debug("runLoop() exited");
  }

  private transition(to: LoopState): void {
    const from = this.state;
    this.state = to;
    this.logger.debug(`state: ${from} → ${to}`);
    this.eventSink.emit({
      type: "state_changed",
      timestamp: this.clock.now().toISOString(),
      data: { from, to },
    });
  }

  private createLogCallback(role: string): (entry: ProcessLogEntry) => void {
    return (entry) => {
      this.eventSink.emit({
        type: "process_output",
        timestamp: this.clock.now().toISOString(),
        data: { role, cycleNumber: this.cycleNumber, entry },
      });
    };
  }

  private async runAudit(): Promise<void> {
    this.logger.debug(`audit: starting (cycle ${this.cycleNumber})`);
    this.metrics.superegoAudits++;
    try {
      const report = await this.superego.audit(this.createLogCallback("SUPEREGO"));
      await this.superego.logAudit(report.summary);
      this.logger.debug(`audit: complete — ${report.summary}`);
    } catch (err) {
      this.logger.debug(`audit: failed — ${err instanceof Error ? err.message : String(err)}`);
    }
    this.eventSink.emit({
      type: "audit_complete",
      timestamp: this.clock.now().toISOString(),
      data: { cycleNumber: this.cycleNumber },
    });
  }
}
