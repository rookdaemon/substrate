import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../claude/ClaudeSessionLauncher";
import { ProcessLogEntry } from "../claude/StreamJsonParser";
import { PlanParser } from "../parsers/PlanParser";
import { AgentRole } from "../types";

export interface GoalCandidate {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
}

export interface IdleDetectionResult {
  idle: boolean;
  reason: string;
}

export class Id {
  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly checker: PermissionChecker,
    private readonly promptBuilder: PromptBuilder,
    private readonly sessionLauncher: ClaudeSessionLauncher,
    private readonly clock: IClock
  ) {}

  async detectIdle(): Promise<IdleDetectionResult> {
    this.checker.assertCanRead(AgentRole.ID, SubstrateFileType.PLAN);
    const planContent = await this.reader.read(SubstrateFileType.PLAN);
    const tasks = PlanParser.parseTasks(planContent.rawMarkdown);

    if (PlanParser.isEmpty(tasks)) {
      return { idle: true, reason: "Plan is empty — no tasks defined" };
    }

    if (PlanParser.isComplete(tasks)) {
      return { idle: true, reason: "All tasks are complete" };
    }

    return { idle: false, reason: "Plan has pending tasks" };
  }

  async generateDrives(onLogEntry?: (entry: ProcessLogEntry) => void): Promise<GoalCandidate[]> {
    try {
      const systemPrompt = await this.promptBuilder.buildSystemPrompt(AgentRole.ID);
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: "Analyze the current state. Are we idle? What goals should we pursue?",
      }, { onLogEntry });

      if (!result.success) return [];

      const parsed = JSON.parse(result.rawOutput);
      if (!Array.isArray(parsed.goalCandidates)) return [];

      return parsed.goalCandidates;
    } catch {
      return [];
    }
  }
}
