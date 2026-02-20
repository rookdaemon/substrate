import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { SubstrateFileWriter } from "../../substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../substrate/io/AppendOnlyWriter";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry } from "../claude/ISessionLauncher";
import { PlanParser } from "../parsers/PlanParser";
import { extractJson } from "../parsers/extractJson";
import { AgentRole } from "../types";
import { TaskClassifier } from "../TaskClassifier";
import { ConversationManager } from "../../conversation/ConversationManager";

export interface SubconsciousProposal {
  target: string;
  content: string;
}

export interface TaskResult {
  result: "success" | "failure" | "partial";
  summary: string;
  progressEntry: string;
  skillUpdates: string | null;
  memoryUpdates: string | null;
  proposals: SubconsciousProposal[];
}

export interface OutcomeEvaluation {
  outcomeMatchesIntent: boolean;
  qualityScore: number; // 0-100
  issuesFound: string[];
  recommendedActions: string[];
  needsReassessment: boolean;
}

export interface TaskAssignment {
  taskId: string;
  description: string;
}

export class Subconscious {
  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly writer: SubstrateFileWriter,
    private readonly appendWriter: AppendOnlyWriter,
    private readonly conversationManager: ConversationManager,
    private readonly checker: PermissionChecker,
    private readonly promptBuilder: PromptBuilder,
    private readonly sessionLauncher: ISessionLauncher,
    private readonly clock: IClock,
    private readonly taskClassifier: TaskClassifier,
    private readonly workingDirectory?: string
  ) {}

  async execute(task: TaskAssignment, onLogEntry?: (entry: ProcessLogEntry) => void): Promise<TaskResult> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      const eagerRefs = this.promptBuilder.getEagerReferences(AgentRole.SUBCONSCIOUS);
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.SUBCONSCIOUS);
      
      let message = "";
      if (eagerRefs) {
        message += `=== CONTEXT (auto-loaded) ===\n${eagerRefs}\n\n`;
      }
      if (lazyRefs) {
        message += `=== AVAILABLE FILES (read on demand) ===\nUse the Read tool to access any of these when needed:\n${lazyRefs}\n\n`;
      }
      message += `Execute this task:\nID: ${task.taskId}\nDescription: ${task.description}`;
      
      const model = this.taskClassifier.getModel({ role: AgentRole.SUBCONSCIOUS, operation: "execute" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, { model, onLogEntry, cwd: this.workingDirectory });

      if (!result.success) {
        const errorDetail = result.rawOutput || result.error || "Claude session error";
        return {
          result: "failure",
          summary: `Task execution failed: ${errorDetail}`,
          progressEntry: "",
          skillUpdates: null,
          memoryUpdates: null,
          proposals: [],
        };
      }

      const parsed = extractJson(result.rawOutput);
      return {
        result: (parsed.result as "success" | "failure" | "partial" | undefined) ?? "failure",
        summary: (parsed.summary as string | undefined) ?? "",
        progressEntry: (parsed.progressEntry as string | undefined) ?? "",
        skillUpdates: (parsed.skillUpdates as string | null | undefined) ?? null,
        memoryUpdates: (parsed.memoryUpdates as string | null | undefined) ?? null,
        proposals: (parsed.proposals as SubconsciousProposal[] | undefined) ?? [],
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        result: "failure",
        summary: `Task execution failed: ${msg}`,
        progressEntry: "",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };
    }
  }

  async logConversation(entry: string): Promise<void> {
    await this.conversationManager.append(AgentRole.SUBCONSCIOUS, entry);
  }

  async logProgress(entry: string): Promise<void> {
    this.checker.assertCanAppend(AgentRole.SUBCONSCIOUS, SubstrateFileType.PROGRESS);
    await this.appendWriter.append(SubstrateFileType.PROGRESS, `[SUBCONSCIOUS] ${entry}`);
  }

  async markTaskComplete(taskId: string): Promise<void> {
    this.checker.assertCanWrite(AgentRole.SUBCONSCIOUS, SubstrateFileType.PLAN);
    const planContent = await this.reader.read(SubstrateFileType.PLAN);
    const updatedMarkdown = PlanParser.markComplete(planContent.rawMarkdown, taskId);
    await this.writer.write(SubstrateFileType.PLAN, updatedMarkdown);
  }

  async updateSkills(content: string): Promise<void> {
    this.checker.assertCanWrite(AgentRole.SUBCONSCIOUS, SubstrateFileType.SKILLS);
    await this.writer.write(SubstrateFileType.SKILLS, content);
  }

  async updateMemory(content: string): Promise<void> {
    this.checker.assertCanWrite(AgentRole.SUBCONSCIOUS, SubstrateFileType.MEMORY);
    await this.writer.write(SubstrateFileType.MEMORY, content);
  }

  /**
   * Compute a 0-10 quality rating for a completed Id-generated drive task.
   * Uses heuristics based on the task outcome without requiring an LLM call.
   */
  static computeDriveRating(result: TaskResult): number {
    let score = 5; // baseline
    if (result.memoryUpdates || result.skillUpdates) score += 3;
    if (result.result === "failure") score -= 2;
    if (
      result.progressEntry.toLowerCase().includes("blog") ||
      result.progressEntry.toLowerCase().includes(" pr ") ||
      result.progressEntry.toLowerCase().includes("pull request")
    ) {
      score += 4;
    }
    return Math.max(0, Math.min(10, score));
  }

  async evaluateOutcome(
    task: TaskAssignment,
    result: TaskResult,
    onLogEntry?: (entry: ProcessLogEntry) => void
  ): Promise<OutcomeEvaluation> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      const eagerRefs = this.promptBuilder.getEagerReferences(AgentRole.SUBCONSCIOUS);
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.SUBCONSCIOUS);

      let evaluationPrompt = "";
      if (eagerRefs) {
        evaluationPrompt += `=== CONTEXT (auto-loaded) ===\n${eagerRefs}\n\n`;
      }
      if (lazyRefs) {
        evaluationPrompt += `=== AVAILABLE FILES (read on demand) ===\nUse the Read tool to access any of these when needed:\n${lazyRefs}\n\n`;
      }

      evaluationPrompt += `You just completed this task:
ID: ${task.taskId}
Description: ${task.description}

The execution result was:
Result: ${result.result}
Summary: ${result.summary}
Progress Entry: ${result.progressEntry}

Now perform a reconsideration evaluation. Assess:
1. Did this task achieve its intended outcome?
2. What is the quality of the work (0-100)?
3. Were there any issues or gaps?
4. What follow-up actions are recommended?
5. Does the goal need reassessment?

Respond with ONLY a JSON object:
{
  "outcomeMatchesIntent": boolean,
  "qualityScore": number (0-100),
  "issuesFound": string[],
  "recommendedActions": string[],
  "needsReassessment": boolean
}`;

      const model = this.taskClassifier.getModel({ role: AgentRole.SUBCONSCIOUS, operation: "evaluateOutcome" });
      const evalResult = await this.sessionLauncher.launch({
        systemPrompt,
        message: evaluationPrompt,
      }, { model, onLogEntry, cwd: this.workingDirectory });

      if (!evalResult.success) {
        // Default to conservative evaluation on failure
        return {
          outcomeMatchesIntent: false,
          qualityScore: 0,
          issuesFound: [`Evaluation failed: ${evalResult.error || "unknown error"}`],
          recommendedActions: ["Re-attempt task", "Review error logs"],
          needsReassessment: true,
        };
      }

      const parsed = extractJson(evalResult.rawOutput);
      
      // Extract raw values from Claude's response
      const outcomeMatchesIntent = (parsed.outcomeMatchesIntent as boolean | undefined) ?? false;
      const qualityScore = (parsed.qualityScore as number | undefined) ?? 0;
      const issuesFound = (parsed.issuesFound as string[] | undefined) ?? [];
      const recommendedActions = (parsed.recommendedActions as string[] | undefined) ?? [];
      let needsReassessment = (parsed.needsReassessment as boolean | undefined) ?? false;

      // Post-processing: Enforce logical consistency rules
      // Rule 1: If quality score is 0, ALWAYS reassess (critical failure)
      if (qualityScore === 0) {
        needsReassessment = true;
      }
      
      // Rule 2: If outcome doesn't match intent AND quality is below threshold (70), ALWAYS reassess
      const QUALITY_THRESHOLD = 70;
      if (!outcomeMatchesIntent && qualityScore < QUALITY_THRESHOLD) {
        needsReassessment = true;
      }

      return {
        outcomeMatchesIntent,
        qualityScore,
        issuesFound,
        recommendedActions,
        needsReassessment,
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        outcomeMatchesIntent: false,
        qualityScore: 0,
        issuesFound: [`Evaluation error: ${msg}`],
        recommendedActions: ["Review evaluation system", "Check logs"],
        needsReassessment: true,
      };
    }
  }
}
