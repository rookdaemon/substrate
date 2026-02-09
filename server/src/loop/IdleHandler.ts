import { Id } from "../agents/roles/Id";
import { Superego } from "../agents/roles/Superego";
import { Ego } from "../agents/roles/Ego";
import { ProcessLogEntry } from "../agents/claude/StreamJsonParser";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { SubstrateFileType } from "../substrate/types";
import { IClock } from "../substrate/abstractions/IClock";

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
    private readonly clock: IClock
  ) {}

  async handleIdle(createLogCallback?: (role: string) => (entry: ProcessLogEntry) => void): Promise<IdleHandlerResult> {
    // Step 1: Confirm idle via Id
    const detection = await this.id.detectIdle();
    if (!detection.idle) {
      return { action: "not_idle" };
    }

    // Step 2: Generate goal candidates
    const candidates = await this.id.generateDrives(createLogCallback?.("ID"));
    if (candidates.length === 0) {
      return { action: "no_goals" };
    }

    // Step 3: Log idle detection
    await this.appendWriter.append(
      SubstrateFileType.PROGRESS,
      `[ID] Idle detected: ${detection.reason}. Generated ${candidates.length} goal candidate(s).`
    );

    // Step 4: Have Superego evaluate candidates as proposals
    const proposals = candidates.map((c) => ({
      target: "PLAN",
      content: `${c.title}: ${c.description}`,
    }));

    const evaluations = await this.superego.evaluateProposals(proposals, createLogCallback?.("SUPEREGO"));

    // Step 5: Filter to approved goals
    const approved = candidates.filter((_, i) => evaluations[i]?.approved);
    if (approved.length === 0) {
      return { action: "all_rejected" };
    }

    // Step 6: Write new plan from approved goals
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

    return { action: "plan_created", goalCount: approved.length };
  }
}
