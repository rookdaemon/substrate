import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry } from "../claude/ISessionLauncher";
import { PlanParser } from "../parsers/PlanParser";
import { extractJson } from "../parsers/extractJson";
import { AgentRole } from "../types";

export interface GoalCandidate {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  confidence: number; // 0-100: how certain the ID is that this goal is appropriate
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
    private readonly sessionLauncher: ISessionLauncher,
    private readonly clock: IClock,
    private readonly workingDirectory?: string
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
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.ID);
      const contextRefs = this.promptBuilder.getContextReferences(AgentRole.ID);
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: `${contextRefs}\n\nAnalyze the current state. Are we idle? What goals should we pursue?`,
      }, { onLogEntry, cwd: this.workingDirectory });

      if (!result.success) return [];

      const parsed = extractJson(result.rawOutput);
      if (!Array.isArray(parsed.goalCandidates)) return [];

      return parsed.goalCandidates;
    } catch {
      return [];  // Id silently returns empty — errors surface through other agents
    }
  }
}
