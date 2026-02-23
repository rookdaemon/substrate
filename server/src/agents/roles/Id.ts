import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry } from "../claude/ISessionLauncher";
import { PlanParser } from "../parsers/PlanParser";
import { extractJson } from "../parsers/extractJson";
import { AgentRole } from "../types";
import { TaskClassifier } from "../TaskClassifier";
import { DriveQualityTracker } from "../../evaluation/DriveQualityTracker";

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
    private readonly taskClassifier: TaskClassifier,
    private readonly workingDirectory?: string,
    private readonly driveQualityTracker?: DriveQualityTracker
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
      const eagerRefs = await this.promptBuilder.getEagerReferences(AgentRole.ID);
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.ID);
      
      let message = "";
      if (eagerRefs) {
        message += `=== CONTEXT (auto-loaded) ===\n${eagerRefs}\n\n`;
      }
      if (lazyRefs) {
        message += `=== AVAILABLE FILES (read on demand) ===\nUse the Read tool to access any of these when needed:\n${lazyRefs}\n\n`;
      }

      if (this.driveQualityTracker) {
        const categoryStats = await this.driveQualityTracker.getCategoryStats();
        const statEntries = Object.entries(categoryStats);
        if (statEntries.length > 0) {
          const statsText = statEntries
            .map(([cat, s]) => `  ${cat}: ${s.avgRating.toFixed(1)}/10 avg (${s.count} task${s.count === 1 ? "" : "s"})`)
            .join("\n");
          message += `=== HISTORICAL DRIVE QUALITY ===\nAverage ratings by category (higher is better):\n${statsText}\n\nPrioritize categories with higher historical ratings. Avoid repeatedly suggesting drives in consistently low-performing categories unless there is clear strategic reason.\n\n`;
        }
      }

      message += `Analyze the current state. Are we idle? What goals should we pursue?`;
      
      const model = this.taskClassifier.getModel({ role: AgentRole.ID, operation: "generateDrives" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, { model, onLogEntry, cwd: this.workingDirectory });

      if (!result.success) return [];

      const parsed = extractJson(result.rawOutput);
      if (!Array.isArray(parsed.goalCandidates)) return [];

      return parsed.goalCandidates;
    } catch {
      return [];  // Id silently returns empty — errors surface through other agents
    }
  }
}
