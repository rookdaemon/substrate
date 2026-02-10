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
    private readonly checker: PermissionChecker,
    private readonly promptBuilder: PromptBuilder,
    private readonly sessionLauncher: ISessionLauncher,
    private readonly clock: IClock,
    private readonly workingDirectory?: string
  ) {}

  async execute(task: TaskAssignment, onLogEntry?: (entry: ProcessLogEntry) => void): Promise<TaskResult> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      const contextRefs = this.promptBuilder.getContextReferences(AgentRole.SUBCONSCIOUS);
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: `${contextRefs}\n\nExecute this task:\nID: ${task.taskId}\nDescription: ${task.description}`,
      }, { onLogEntry, cwd: this.workingDirectory });

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
    this.checker.assertCanAppend(AgentRole.SUBCONSCIOUS, SubstrateFileType.CONVERSATION);
    await this.appendWriter.append(SubstrateFileType.CONVERSATION, `[SUBCONSCIOUS] ${entry}`);
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

  async evaluateOutcome(
    task: TaskAssignment,
    result: TaskResult,
    onLogEntry?: (entry: ProcessLogEntry) => void
  ): Promise<OutcomeEvaluation> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      const contextRefs = this.promptBuilder.getContextReferences(AgentRole.SUBCONSCIOUS);

      const evaluationPrompt = `${contextRefs}

You just completed this task:
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

      const evalResult = await this.sessionLauncher.launch({
        systemPrompt,
        message: evaluationPrompt,
      }, { onLogEntry, cwd: this.workingDirectory });

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
      return {
        outcomeMatchesIntent: (parsed.outcomeMatchesIntent as boolean | undefined) ?? false,
        qualityScore: (parsed.qualityScore as number | undefined) ?? 0,
        issuesFound: (parsed.issuesFound as string[] | undefined) ?? [],
        recommendedActions: (parsed.recommendedActions as string[] | undefined) ?? [],
        needsReassessment: (parsed.needsReassessment as boolean | undefined) ?? false,
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
