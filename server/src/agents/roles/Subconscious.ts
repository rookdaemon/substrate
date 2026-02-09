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
        return {
          result: "failure",
          summary: `Task execution failed: ${result.error || "Claude session error"}`,
          progressEntry: "",
          skillUpdates: null,
          memoryUpdates: null,
          proposals: [],
        };
      }

      const parsed = extractJson(result.rawOutput);
      return {
        result: parsed.result ?? "failure",
        summary: parsed.summary ?? "",
        progressEntry: parsed.progressEntry ?? "",
        skillUpdates: parsed.skillUpdates ?? null,
        memoryUpdates: parsed.memoryUpdates ?? null,
        proposals: parsed.proposals ?? [],
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
}
