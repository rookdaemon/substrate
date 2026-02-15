import { Id } from "../agents/roles/Id";
import { Superego } from "../agents/roles/Superego";
import { Ego } from "../agents/roles/Ego";
import { ProcessLogEntry } from "../agents/claude/ISessionLauncher";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { SubstrateFileType } from "../substrate/types";
import { IClock } from "../substrate/abstractions/IClock";
import { ILogger } from "../logging";

export interface IdleHandlerResult {
  action: "plan_created" | "no_goals" | "all_rejected" | "not_idle";
  goalCount?: number;
}

export class IdleHandler {
  constructor(
    private readonly id: Id,
    private readonly superego: Superego,
    private readonly ego: Ego,
    private readonly appendWriter: AppendOnlyWriter,
    private readonly clock: IClock,
    private readonly logger: ILogger
  ) {}

  async handleIdle(createLogCallback?: (role: string) => (entry: ProcessLogEntry) => void): Promise<IdleHandlerResult> {
    // Step 1: Confirm idle via Id
    this.logger.debug("IdleHandler: detecting idle state");
    const detection = await this.id.detectIdle();
    if (!detection.idle) {
      this.logger.debug("IdleHandler: not idle, skipping");
      return { action: "not_idle" };
    }

    // Step 2: Generate goal candidates
    this.logger.debug(`IdleHandler: idle detected (${detection.reason}), generating drives`);
    const candidates = await this.id.generateDrives(createLogCallback?.("ID"));
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

    // Step 7: Write new plan from approved goals
    this.logger.debug(`IdleHandler: ${approved.length} proposal(s) approved, writing plan`);
    const planLines = [
      "# Plan",
      "",
      "## Current Goal",
      approved.map((g) => g.title).join(", "),
      "",
      "## Tasks",
      ...approved.map((g) => `- [ ] ${g.title}: ${g.description}`),
    ];
    await this.ego.writePlan(planLines.join("\n"));

    this.logger.debug("IdleHandler: plan written successfully");
    return { action: "plan_created", goalCount: approved.length };
  }
}
