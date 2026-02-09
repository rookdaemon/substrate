import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { SubstrateFileWriter } from "../../substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../substrate/io/AppendOnlyWriter";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../claude/ClaudeSessionLauncher";
import { ProcessLogEntry } from "../claude/StreamJsonParser";
import { PlanParser } from "../parsers/PlanParser";
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
    private readonly sessionLauncher: ClaudeSessionLauncher,
    private readonly clock: IClock,
    private readonly workingDirectory?: string
  ) {}

  async execute(task: TaskAssignment, onLogEntry?: (entry: ProcessLogEntry) => void): Promise<TaskResult> {
    try {
      const systemPrompt = await this.promptBuilder.buildSystemPrompt(AgentRole.SUBCONSCIOUS);
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: `Execute this task:\nID: ${task.taskId}\nDescription: ${task.description}`,
      }, { onLogEntry, cwd: this.workingDirectory });

      if (!result.success) {
        return {
          result: "failure",
          summary: "Task execution failed: Claude session error",
          progressEntry: "",
          skillUpdates: null,
          proposals: [],
        };
      }

      const parsed = JSON.parse(result.rawOutput);
      return {
        result: parsed.result ?? "failure",
        summary: parsed.summary ?? "",
        progressEntry: parsed.progressEntry ?? "",
        skillUpdates: parsed.skillUpdates ?? null,
        proposals: parsed.proposals ?? [],
      };
    } catch {
      return {
        result: "failure",
        summary: "Task execution failed: unexpected error",
        progressEntry: "",
        skillUpdates: null,
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
}
