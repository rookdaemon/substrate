import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { SubstrateFileWriter } from "../../substrate/io/FileWriter";
import { ConversationManager } from "../../conversation/ConversationManager";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry } from "../claude/ISessionLauncher";
import { PlanParser } from "../parsers/PlanParser";
import { extractJson } from "../parsers/extractJson";
import { AgentRole } from "../types";
import { TaskClassifier } from "../TaskClassifier";

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
    private readonly conversationManager: ConversationManager,
    private readonly checker: PermissionChecker,
    private readonly promptBuilder: PromptBuilder,
    private readonly sessionLauncher: ISessionLauncher,
    private readonly clock: IClock,
    private readonly taskClassifier: TaskClassifier,
    private readonly workingDirectory?: string
  ) {}

  async decide(onLogEntry?: (entry: ProcessLogEntry) => void): Promise<EgoDecision> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.EGO);
      const contextRefs = this.promptBuilder.getContextReferences(AgentRole.EGO);
      const model = this.taskClassifier.getModel({ role: AgentRole.EGO, operation: "decide" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: `${contextRefs}\n\nAnalyze the current context. What should we do next?`,
      }, { model, onLogEntry, cwd: this.workingDirectory });

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
    await this.conversationManager.append(AgentRole.EGO, entry);
  }

  async respondToMessage(
    message: string,
    onLogEntry?: (entry: ProcessLogEntry) => void
  ): Promise<string | null> {
    const contextRefs = this.promptBuilder.getContextReferences(AgentRole.EGO);

    const systemPrompt =
      `You are the Ego — the executive decision-maker of a self-improving AI agent system.\n` +
      `A user has sent you a message. Read CONVERSATION.md for context and respond naturally.\n` +
      `Respond with ONLY your plain text reply — no JSON, no markdown code blocks, no wrapper.\n` +
      `Keep responses concise and conversational.`;

    const model = this.taskClassifier.getModel({ role: AgentRole.EGO, operation: "respondToMessage" });
    const result = await this.sessionLauncher.launch({
      systemPrompt,
      message: `${contextRefs}\n\nUser message: "${message}"`,
    }, { model, onLogEntry, cwd: this.workingDirectory });

    if (result.success && result.rawOutput) {
      const response = result.rawOutput.trim();
      await this.appendConversation(response);
      return response;
    }
    return null;
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
