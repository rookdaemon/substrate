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
import { extractJson } from "../parsers/extractJson";
import { AgentRole } from "../types";

export interface EgoDecision {
  action: "dispatch" | "update_plan" | "converse" | "idle";
  [key: string]: unknown;
}

export interface DispatchResult {
  targetRole: AgentRole;
  taskId: string;
  description: string;
}

export class Ego {
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

  async decide(onLogEntry?: (entry: ProcessLogEntry) => void): Promise<EgoDecision> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.EGO);
      const contextRefs = this.promptBuilder.getContextReferences(AgentRole.EGO);
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: `${contextRefs}\n\nAnalyze the current context. What should we do next?`,
      }, { onLogEntry, cwd: this.workingDirectory });

      if (!result.success) {
        return { action: "idle", reason: `Claude session error: ${result.error || "unknown"}` };
      }

      const parsed = extractJson(result.rawOutput);
      return parsed as EgoDecision;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { action: "idle", reason: `Decision failed: ${msg}` };
    }
  }

  async readPlan(): Promise<string> {
    this.checker.assertCanRead(AgentRole.EGO, SubstrateFileType.PLAN);
    const content = await this.reader.read(SubstrateFileType.PLAN);
    return content.rawMarkdown;
  }

  async writePlan(content: string): Promise<void> {
    this.checker.assertCanWrite(AgentRole.EGO, SubstrateFileType.PLAN);
    await this.writer.write(SubstrateFileType.PLAN, content);
  }

  async appendConversation(entry: string): Promise<void> {
    this.checker.assertCanAppend(AgentRole.EGO, SubstrateFileType.CONVERSATION);
    await this.appendWriter.append(SubstrateFileType.CONVERSATION, `[EGO] ${entry}`);
  }

  async dispatchNext(): Promise<DispatchResult | null> {
    this.checker.assertCanRead(AgentRole.EGO, SubstrateFileType.PLAN);
    const planContent = await this.reader.read(SubstrateFileType.PLAN);
    const tasks = PlanParser.parseTasks(planContent.rawMarkdown);
    const next = PlanParser.findNextActionable(tasks);

    if (!next) return null;

    return {
      targetRole: AgentRole.SUBCONSCIOUS,
      taskId: next.id,
      description: next.title,
    };
  }
}
