import { IClock } from "../../substrate/abstractions/IClock";
import { ILogger } from "../../logging";
import {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
  ProcessLogEntry,
} from "./ISessionLauncher";
import { MessageChannel } from "../../session/MessageChannel";
import { SdkUserMessage } from "../../session/ISdkSession";

// Minimal SDK-compatible types so we don't leak transitive SDK dependencies
export interface SdkContentBlock {
  type: string;
  text?: string;
  thinking?: string;
  name?: string;
  input?: unknown;
  content?: unknown;
}

export interface SdkAssistantMessage {
  type: "assistant";
  message: { content: SdkContentBlock[] };
}

export interface SdkResultSuccess {
  type: "result";
  subtype: "success";
  result: string;
  total_cost_usd: number;
  duration_ms: number;
}

export interface SdkResultError {
  type: "result";
  subtype: string;
  errors: string[];
  total_cost_usd: number;
  duration_ms: number;
}

export interface SdkSystemMessage {
  type: "system";
  subtype: "init";
  model: string;
  claude_code_version: string;
}

export type SdkMessage =
  | SdkAssistantMessage
  | SdkResultSuccess
  | SdkResultError
  | SdkSystemMessage
  | { type: string };

export type SdkQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<SdkMessage>;

const noopLogger: ILogger = { debug() {} };

export class AgentSdkLauncher implements ISessionLauncher {
  private readonly model: string;
  private readonly logger: ILogger;
  private activeChannel: MessageChannel<SdkUserMessage> | null = null;

  constructor(
    private readonly queryFn: SdkQueryFn,
    private readonly clock: IClock,
    model?: string,
    logger?: ILogger,
  ) {
    this.model = model ?? "sonnet";
    this.logger = logger ?? noopLogger;
  }

  inject(message: string): void {
    if (!this.activeChannel) {
      this.logger.debug("sdk-launch: inject called but no active session");
      return;
    }
    this.logger.debug(`sdk-launch: inject message (${message.length} chars)`);
    const userMessage: SdkUserMessage = {
      type: "user",
      message: { role: "user", content: message },
      parent_tool_use_id: null,
      session_id: "injected",
    };
    this.activeChannel.push(userMessage);
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const maxRetries = options?.maxRetries ?? 0;
    const retryDelayMs = options?.retryDelayMs ?? 1000;
    
    let lastError: ClaudeSessionResult | null = null;
    
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      if (attempt > 0) {
        this.logger.debug(`sdk-launch: retry attempt ${attempt}/${maxRetries} after ${retryDelayMs}ms`);
        await new Promise(r => setTimeout(r, retryDelayMs));
      }
      
      const result = await this.executeLaunch(request, options);
      
      if (result.success) {
        return result;
      }
      
      lastError = result;
    }
    
    return lastError!;
  }

  private async executeLaunch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startTime = this.clock.now();

    const modelToUse = options?.model ?? this.model;
    this.logger.debug(`sdk-launch: model=${modelToUse} cwd=${options?.cwd ?? "(inherit)"}`);

    const queryOptions: Record<string, unknown> = {
      systemPrompt: request.systemPrompt,
      model: modelToUse,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: false,
    };

    if (options?.cwd) {
      queryOptions.cwd = options.cwd;
    }

    let accumulatedText = "";
    let resultOutput: string | null = null;
    let isError = false;
    let errorMessage: string | undefined;

    try {
      const stream = this.queryFn({ prompt: request.message, options: queryOptions });

      // Wire message injection via streamInput if the SDK stream supports it
      this.activeChannel = new MessageChannel<SdkUserMessage>();
      const streamWithInput = stream as { streamInput?: (s: AsyncIterable<SdkUserMessage>) => Promise<void> };
      if (typeof streamWithInput.streamInput === "function") {
        streamWithInput.streamInput(this.activeChannel).catch((err) => {
          this.logger.debug(`sdk-launch: streamInput error — ${err instanceof Error ? err.message : String(err)}`);
        });
      }

      for await (const msg of stream) {
        this.processMessage(msg, options?.onLogEntry, (text) => {
          accumulatedText += text;
        });

        if (msg.type === "result") {
          this.logger.debug(`sdk-launch: result message: ${JSON.stringify(msg)}`);
          const resultMsg = msg as SdkResultSuccess | SdkResultError;
          if (resultMsg.subtype === "success") {
            resultOutput = (resultMsg as SdkResultSuccess).result;
          } else {
            isError = true;
            const errMsg = resultMsg as SdkResultError;
            errorMessage = errMsg.errors?.join("; ") ?? resultMsg.subtype;
          }
        }
      }
    } catch (err) {
      isError = true;
      errorMessage = err instanceof Error ? err.message : String(err);
      this.logger.debug(`sdk-launch: error — ${errorMessage}`);
    } finally {
      if (this.activeChannel && !this.activeChannel.isClosed()) {
        this.activeChannel.close();
      }
      this.activeChannel = null;
    }

    const endTime = this.clock.now();
    const durationMs = endTime.getTime() - startTime.getTime();

    const rawOutput = resultOutput || accumulatedText;

    this.logger.debug(
      `sdk-launch: done — success=${!isError} duration=${durationMs}ms output="${rawOutput}"`,
    );

    return {
      rawOutput,
      exitCode: isError ? 1 : 0,
      durationMs,
      success: !isError,
      error: errorMessage,
    };
  }

  private processMessage(
    msg: SdkMessage,
    onLogEntry: ((entry: ProcessLogEntry) => void) | undefined,
    onText: (text: string) => void,
  ): void {
    if (!onLogEntry && msg.type !== "assistant") return;

    switch (msg.type) {
      case "system": {
        const sys = msg as SdkSystemMessage;
        if (sys.subtype === "init") {
          const entry: ProcessLogEntry = {
            type: "status",
            content: `init: model=${sys.model} v${sys.claude_code_version}`,
          };
          this.logger.debug(`  [${entry.type}] ${entry.content}`);
          onLogEntry?.(entry);
        }
        break;
      }
      case "assistant": {
        const asst = msg as SdkAssistantMessage;
        for (const block of asst.message.content) {
          const entry = this.mapContentBlock(block);
          if (entry.type === "text") {
            onText(entry.content);
          }
          this.logger.debug(`  [${entry.type}] ${entry.content}`);
          onLogEntry?.(entry);
        }
        break;
      }
      case "result": {
        const res = msg as SdkResultSuccess | SdkResultError;
        const parts: string[] = [res.subtype];
        if (res.total_cost_usd !== undefined) parts.push(`$${res.total_cost_usd.toFixed(4)}`);
        if (res.duration_ms !== undefined) parts.push(`${res.duration_ms}ms`);
        const entry: ProcessLogEntry = { type: "status", content: `result: ${parts.join(", ")}` };
        this.logger.debug(`  [${entry.type}] ${entry.content}`);
        onLogEntry?.(entry);
        break;
      }
      default:
        break;
    }
  }

  private mapContentBlock(block: SdkContentBlock): ProcessLogEntry {
    switch (block.type) {
      case "thinking":
        return { type: "thinking", content: block.thinking ?? "" };
      case "text":
        return { type: "text", content: block.text ?? "" };
      case "tool_use": {
        const name = block.name ?? "unknown";
        const input = block.input ? JSON.stringify(block.input) : "{}";
        return { type: "tool_use", content: `${name}: ${input}` };
      }
      case "tool_result": {
        const content = typeof block.content === "string"
          ? block.content
          : JSON.stringify(block.content ?? "");
        return { type: "tool_result", content };
      }
      default:
        return { type: "status", content: block.type ?? "unknown_block" };
    }
  }
}
