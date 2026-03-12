import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { SubstrateFileWriter } from "../../substrate/io/FileWriter";
import { ConversationManager } from "../../conversation/ConversationManager";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry, LaunchOptions } from "../claude/ISessionLauncher";
import { PlanParser } from "../parsers/PlanParser";
import { ShellTriggerEvaluator } from "../parsers/ShellTriggerEvaluator";
import { extractJson } from "../parsers/extractJson";
import { AgentRole } from "../types";
import { TaskClassifier } from "../TaskClassifier";
import { AgoraReply } from "./Subconscious";
import { RateLimitError } from "../../loop/RateLimitError";
import { isRateLimitText } from "../../loop/rateLimitParser";

export interface EgoDecision {
  action: "dispatch" | "update_plan" | "converse" | "idle";
  taskId?: string;       // present when action === "dispatch"
  description?: string;  // present when action === "dispatch"
  content?: string;      // present when action === "update_plan"
  entry?: string;        // present when action === "converse"
  reason?: string;       // present when action === "idle"
  agoraReplies: AgoraReply[];
}

/**
 * JSON Schema for EgoDecision — used by OllamaSessionLauncher for
 * grammar-constrained decoding via the `format` field.
 */
export const EGO_DECISION_SCHEMA = {
  type: "object",
  properties: {
    action: {
      type: "string",
      enum: ["dispatch", "update_plan", "converse", "idle"],
    },
    taskId: { type: "string" },
    description: { type: "string" },
    content: { type: "string" },
    entry: { type: "string" },
    reason: { type: "string" },
    agoraReplies: {
      type: "array",
      items: {
        type: "object",
        properties: {
          to: { type: "string" },
          text: { type: "string" },
          inReplyTo: { type: "string" },
        },
        required: ["to", "text"],
      },
    },
  },
  required: ["action", "agoraReplies"],
} as const;

export interface DispatchResult {
  targetRole: AgentRole;
  taskId: string;
  description: string;
  correlationId?: string;
}

export interface DispatchNextResult {
  dispatch: DispatchResult | null;
  blockedTaskIds: string[];
}

export class Ego {
  private readonly triggerEvaluator = new ShellTriggerEvaluator();

  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly writer: SubstrateFileWriter,
    private readonly conversationManager: ConversationManager,
    private readonly checker: PermissionChecker,
    private readonly promptBuilder: PromptBuilder,
    private readonly sessionLauncher: ISessionLauncher,
    private readonly clock: IClock,
    private readonly taskClassifier: TaskClassifier,
    private readonly workingDirectory?: string,
    private readonly sourceCodePath?: string
  ) {}

  async decide(onLogEntry?: (entry: ProcessLogEntry) => void, runtimeContext?: string): Promise<EgoDecision> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.EGO);
      const eagerRefs = await this.promptBuilder.getEagerReferences(AgentRole.EGO);
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.EGO);
      
      const message = this.promptBuilder.buildAgentMessage(
        eagerRefs,
        lazyRefs,
        `Analyze the current context. What should we do next?`,
        runtimeContext
      );
      
      const model = this.taskClassifier.getModel({ role: AgentRole.EGO, operation: "decide" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, {
        model,
        onLogEntry,
        cwd: this.workingDirectory,
        continueSession: true,
        persistSession: true,
        outputSchema: EGO_DECISION_SCHEMA,
        ...(this.sourceCodePath ? { additionalDirs: [this.sourceCodePath] } : {}),
      });

      if (!result.success) {
        return { action: "idle", reason: `Claude session error: ${result.error || "unknown"}`, agoraReplies: [] };
      }

      const parsed = extractJson(result.rawOutput) as EgoDecision;
      if (!Array.isArray(parsed.agoraReplies)) {
        parsed.agoraReplies = [];
      }
      return parsed;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { action: "idle", reason: `Decision failed: ${msg}`, agoraReplies: [] };
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
    onLogEntry?: (entry: ProcessLogEntry) => void,
    options?: LaunchOptions
  ): Promise<string | null> {
    const eagerRefs = await this.promptBuilder.getEagerReferences(AgentRole.EGO);
    const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.EGO);

    let contextSection = "";
    if (eagerRefs) {
      contextSection += `${eagerRefs}\n\n`;
    }
    if (lazyRefs) {
      contextSection += `[FILES — read on demand]\n${lazyRefs}\n\n`;
    }

    const systemPrompt =
      `You are the Ego — the executive decision-maker of a self-improving AI agent system.\n` +
      `A user has sent you a message. Read CONVERSATION.md for context and respond naturally.\n` +
      `Respond with ONLY your plain text reply — no JSON, no markdown code blocks, no wrapper.\n` +
      `Keep responses concise and conversational.\n\n` +
      `If the message is an Agora message, use the dedicated Agora MCP tool (${"`"}mcp__tinybus__send_agora_message${"`"} in Claude Code, or ${"`"}send_agora_message${"`"} in Gemini CLI).\n` +
      `Read the FROM/TO metadata in CONVERSATION.md. The TO list is compacted from full IDs and indicates recipients of the original message.\n` +
      `Reply to known peers with: to: "<peer-ref>", text: "your response", inReplyTo: "envelope-id".\n` +
      `peer-ref can be a configured peer name, full public key, or compact short form.\n` +
      `For unknown senders, use targetPubkey with the full key provided in the injected Agora instruction block.\n` +
      `Always include inReplyTo when replying. It is considered good form to reply to the sender and all recipients of a message, to keep everyone in the loop - unless you have a reason not to.`;

    const model = this.taskClassifier.getModel({ role: AgentRole.EGO, operation: "respondToMessage" });
    const launchOptions: LaunchOptions = {
      model,
      onLogEntry,
      cwd: this.workingDirectory,
      continueSession: true,
      persistSession: true,
      ...(this.sourceCodePath ? { additionalDirs: [this.sourceCodePath] } : {}),
      ...options, // Allow overriding options (e.g. idleTimeoutMs)
    };
    const result = await this.sessionLauncher.launch({
      systemPrompt,
      message: `${contextSection}User message: "${message}"`,
    }, launchOptions);

    if (result.success && result.rawOutput) {
      const response = result.rawOutput.trim();
      await this.appendConversation(response);
      return response;
    }
    if (isRateLimitText(result.error)) throw new RateLimitError(result.error!);
    return null;
  }

  async dispatchNext(): Promise<DispatchNextResult> {
    this.checker.assertCanRead(AgentRole.EGO, SubstrateFileType.PLAN);
    const planContent = await this.reader.read(SubstrateFileType.PLAN);
    const tasks = PlanParser.parseTasks(planContent.rawMarkdown);
    const blockedTaskIds = PlanParser.findBlockedTasks(tasks).map((t) => t.id);
    const next = await PlanParser.findNextActionable(tasks, this.triggerEvaluator);

    if (!next) return { dispatch: null, blockedTaskIds };

    return {
      dispatch: {
        targetRole: AgentRole.SUBCONSCIOUS,
        taskId: next.id,
        description: next.title,
        ...(next.correlationId !== undefined ? { correlationId: next.correlationId } : {}),
      },
      blockedTaskIds,
    };
  }
}
