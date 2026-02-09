import { Ego } from "../agents/roles/Ego";
import { Subconscious } from "../agents/roles/Subconscious";
import { Superego } from "../agents/roles/Superego";
import { Id } from "../agents/roles/Id";
import { ProcessLogEntry } from "../agents/claude/StreamJsonParser";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { IClock } from "../substrate/abstractions/IClock";
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
    this.transition(LoopState.RUNNING);
  }

  pause(): void {
    if (this.state !== LoopState.RUNNING) {
      throw new Error(`Cannot pause: loop is in ${this.state} state`);
    }
    this.transition(LoopState.PAUSED);
  }

  resume(): void {
    if (this.state !== LoopState.PAUSED) {
      throw new Error(`Cannot resume: loop is in ${this.state} state`);
    }
    this.transition(LoopState.RUNNING);
  }

  stop(): void {
    if (this.state === LoopState.STOPPED) {
      return;
    }
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
    this.cycleNumber++;
    this.metrics.totalCycles++;

    const dispatch = await this.ego.dispatchNext();

    let result: CycleResult;

    if (!dispatch) {
      this.metrics.idleCycles++;
      this.metrics.consecutiveIdleCycles++;

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
      const taskResult = await this.subconscious.execute({
        taskId: dispatch.taskId,
        description: dispatch.description,
      }, this.createLogCallback("SUBCONSCIOUS"));

      const success = taskResult.result === "success";

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
      } else {
        this.metrics.failedCycles++;
      }

      if (taskResult.proposals.length > 0) {
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
    while (this.state === LoopState.RUNNING) {
      await this.runOneCycle();

      if (this.metrics.consecutiveIdleCycles >= this.config.maxConsecutiveIdleCycles) {
        if (this.idleHandler) {
          const result = await this.idleHandler.handleIdle((role) => this.createLogCallback(role));
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
        this.stop();
        break;
      }

      if (this.state !== LoopState.RUNNING) {
        break;
      }

      await this.timer.delay(this.config.cycleDelayMs);
    }
  }

  private transition(to: LoopState): void {
    const from = this.state;
    this.state = to;
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
    this.metrics.superegoAudits++;
    try {
      const report = await this.superego.audit(this.createLogCallback("SUPEREGO"));
      await this.superego.logAudit(report.summary);
    } catch {
      // Audit failures are non-fatal
    }
    this.eventSink.emit({
      type: "audit_complete",
      timestamp: this.clock.now().toISOString(),
      data: { cycleNumber: this.cycleNumber },
    });
  }
}
