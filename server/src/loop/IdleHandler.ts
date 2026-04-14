import { Id } from "../agents/roles/Id";
import { Superego } from "../agents/roles/Superego";
import { Ego } from "../agents/roles/Ego";
import { ProcessLogEntry } from "../agents/claude/ISessionLauncher";
import { IClock } from "../substrate/abstractions/IClock";
import { ILogger } from "../logging";
import { CanaryLogger, ConvMdStats } from "../evaluation/CanaryLogger";
import { PlanParser } from "../agents/parsers/PlanParser";

export interface IdleHandlerResult {
  action: "plan_created" | "no_goals" | "all_rejected" | "not_idle";
  goalCount?: number;
}

export class IdleHandler {
  constructor(
    private readonly id: Id,
    private readonly superego: Superego,
    private readonly ego: Ego,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly canaryLogger?: CanaryLogger,
    private readonly launcherName?: string,
    private readonly convMdReader?: () => Promise<ConvMdStats | null>,
  ) {}

  async handleIdle(
    createLogCallback?: (role: string) => (entry: ProcessLogEntry) => void,
    cycleNumber = 0,
  ): Promise<IdleHandlerResult> {
    // Step 1: Confirm idle via Id
    this.logger.debug("IdleHandler: detecting idle state");
    const detection = await this.id.detectIdle();
    if (!detection.idle) {
      this.logger.debug("IdleHandler: not idle, skipping");
      return { action: "not_idle" };
    }

    // Step 2: Generate goal candidates
    this.logger.debug(`IdleHandler: idle detected (${detection.reason}), generating drives`);
    const { candidates, parseErrors } = await this.id.generateDrives(createLogCallback?.("ID"));

    // Step 3: Log canary record regardless of outcome
    if (this.canaryLogger) {
      const highPriority = candidates.filter((c) => c.priority === "high");
      const highPriorityConfidence = highPriority.length > 0
        ? Math.round(highPriority.reduce((sum, c) => sum + c.confidence, 0) / highPriority.length)
        : null;
      const convStats = this.convMdReader ? await this.convMdReader().catch(() => null) : null;
      await this.canaryLogger.recordCycle({
        timestamp: this.clock.now().toISOString(),
        cycle: cycleNumber,
        launcher: this.launcherName ?? "claude",
        candidateCount: candidates.length,
        highPriorityConfidence,
        parseErrors,
        pass: parseErrors === 0 && candidates.length > 0,
        ...(convStats !== null ? { convMdLines: convStats.lines, convMdKb: convStats.kb } : {}),
      }).catch((err) => {
        this.logger.debug(`IdleHandler: canary log write failed — ${err instanceof Error ? err.message : String(err)}`);
      });
    }

    if (candidates.length === 0) {
      this.logger.debug("IdleHandler: no goal candidates generated");
      return { action: "no_goals" };
    }

    this.logger.debug(`IdleHandler: generated ${candidates.length} goal candidate(s)`);

    // Idle detection is emitted via eventSink in LoopOrchestrator and available in systemd logs
    // No need to log to PROGRESS.md as it would pollute the high-level summary file

    // Step 5: Have Superego evaluate candidates as proposals
    const proposals = candidates.map((c) => ({
      target: "PLAN",
      content: `${c.title}: ${c.description}`,
    }));

    this.logger.debug(`IdleHandler: evaluating ${proposals.length} proposal(s) via Superego`);
    const evaluations = await this.superego.evaluateProposals(proposals, createLogCallback?.("SUPEREGO"));

    // Step 6: Filter to approved goals
    const approved = candidates.filter((_, i) => evaluations[i]?.approved);
    if (approved.length === 0) {
      this.logger.debug("IdleHandler: all proposals rejected by Superego");
      return { action: "all_rejected" };
    }

    // Step 7: Read existing plan, then append approved goals to ## Tasks
    this.logger.debug(`IdleHandler: ${approved.length} proposal(s) approved, writing plan`);
    const dateTag = `[ID-generated ${this.clock.now().toISOString().split("T")[0]}]`;
    const newTaskLines = approved.flatMap((g) => {
      const line = `- [ ] ${g.title}: ${g.description} ${dateTag}`;
      const metaComment = `<!-- confidence: ${g.confidence ?? 0} priority: ${g.priority} -->`;
      return g.correlationId
        ? [line, metaComment, `  <!-- correlationId: ${g.correlationId} -->`]
        : [line, metaComment];
    });

    const existingPlan = await this.ego.readPlan();
    const mergedPlan = PlanParser.appendTasksToExistingPlan(
      existingPlan,
      newTaskLines,
    );
    await this.ego.writePlan(mergedPlan);

    this.logger.debug("IdleHandler: plan written successfully");
    return { action: "plan_created", goalCount: approved.length };
  }
}
