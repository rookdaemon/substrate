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
import { ProcessTracker } from "./ProcessTracker";

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

export interface SdkRateLimitInfo {
  status: "allowed" | "allowed_warning" | "rejected";
  resetsAt?: number;
}

export interface SdkRateLimitEvent {
  type: "rate_limit_event";
  rate_limit_info: SdkRateLimitInfo;
}

export type SdkMessage =
  | SdkAssistantMessage
  | SdkResultSuccess
  | SdkResultError
  | SdkSystemMessage
  | SdkRateLimitEvent
  | { type: string };

export type SdkQueryFn = (params: {
  prompt: string;
  options?: Record<string, unknown>;
}) => AsyncIterable<SdkMessage>;

const noopLogger: ILogger = { debug() {}, verbose() {} };
const DEFAULT_SESSION_TIMEOUT_MS = 10 * 60 * 1000; // 10 minutes

export class AgentSdkLauncher implements ISessionLauncher {
  private readonly model: string;
  private readonly logger: ILogger;
  private activeChannel: MessageChannel<SdkUserMessage> | null = null;
  private processTracker: ProcessTracker | null = null;
  private currentPid: number | null = null;
  private readonly mcpServers: Record<string, { type: string; url: string }>;

  constructor(
    private readonly queryFn: SdkQueryFn,
    private readonly clock: IClock,
    model?: string,
    logger?: ILogger,
    processTracker?: ProcessTracker,
    mcpServers?: Record<string, { type: string; url: string }>,
  ) {
    this.model = model ?? "claude-sonnet-4-6";
    this.logger = logger ?? noopLogger;
    this.processTracker = processTracker ?? null;
    this.mcpServers = mcpServers ?? {};
  }

  isActive(): boolean {
    return this.activeChannel !== null;
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

      if (options?.continueSession && this.isContinueError(result)) {
        this.logger.debug("sdk-launch: --continue failed, retrying without continue");
        const fallbackResult = await this.executeLaunch(request, { ...options, continueSession: false });
        if (fallbackResult.success) return fallbackResult;
        lastError = fallbackResult;
        continue;
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

    const mcpEntries = Object.entries(this.mcpServers);
    if (mcpEntries.length > 0) {
      for (const [name, cfg] of mcpEntries) {
        this.logger.debug(`sdk-launch: MCP server registered: ${name} → ${cfg.url}`);
      }
    }
    const queryOptions: Record<string, unknown> = {
      systemPrompt: request.systemPrompt,
      model: modelToUse,
      permissionMode: "bypassPermissions",
      allowDangerouslySkipPermissions: true,
      persistSession: options?.persistSession ?? false,
      ...(options?.continueSession ? { continue: true } : {}),
      ...(Object.keys(this.mcpServers).length > 0 ? { mcpServers: this.mcpServers } : {}),
    };

    if (options?.cwd) {
      queryOptions.cwd = options.cwd;
    }

    if (options?.additionalDirs && options.additionalDirs.length > 0) {
      queryOptions.additionalDirectories = options.additionalDirs;
    }

    let accumulatedText = "";
    let resultOutput: string | null = null;
    let isError = false;
    let errorMessage: string | undefined;
    let rateLimitText: string | null = null;

    const timeoutMs = options?.timeoutMs ?? DEFAULT_SESSION_TIMEOUT_MS;
    const idleTimeoutMs = options?.idleTimeoutMs;
    let timeoutHandle: NodeJS.Timeout | null = null;
    let idleTimeoutHandle: NodeJS.Timeout | null = null;

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

      const timeoutPromise = new Promise<never>((_, reject) => {
        timeoutHandle = setTimeout(() => reject(new Error(`Session timed out after ${timeoutMs}ms`)), timeoutMs);
      });

      // Idle timeout promise (only if idleTimeoutMs is set)
      let idleTimeoutReject: ((err: Error) => void) | null = null;
      let idleTimeoutPromise: Promise<never> | null = null;
      if (idleTimeoutMs) {
        idleTimeoutPromise = new Promise<never>((_, reject) => {
          idleTimeoutReject = reject;
          idleTimeoutHandle = setTimeout(
            () => reject(new Error(`Session idle for ${idleTimeoutMs}ms with no output`)),
            idleTimeoutMs
          );
        });
      }

      const resetIdleTimer = () => {
        if (idleTimeoutMs && idleTimeoutHandle !== null && idleTimeoutReject) {
          clearTimeout(idleTimeoutHandle);
          idleTimeoutHandle = setTimeout(
            () => idleTimeoutReject!(new Error(`Session idle for ${idleTimeoutMs}ms with no output`)),
            idleTimeoutMs
          );
        }
      };

      // Race iteration against timeout(s)
      const racePromises: Promise<unknown>[] = [
        (async () => {
          for await (const msg of stream) {
            // Reset idle timer on each message
            resetIdleTimer();

            this.processMessage(msg, options?.onLogEntry, (text) => {
              accumulatedText += text;
            });

            if (msg.type === "result") {
              this.logger.verbose(`sdk-launch: result message: ${JSON.stringify(msg)}`);
              const resultMsg = msg as SdkResultSuccess | SdkResultError;
              if (resultMsg.subtype === "success") {
                resultOutput = (resultMsg as SdkResultSuccess).result;
              } else {
                isError = true;
                const errMsg = resultMsg as SdkResultError;
                errorMessage = errMsg.errors?.join("; ") ?? resultMsg.subtype;
                // If a rate_limit_event was already received, prefer its text so
                // the orchestrator's parseRateLimitReset can detect and handle it.
                if (rateLimitText) {
                  errorMessage = rateLimitText;
                }
              }
            }

            if (msg.type === "rate_limit_event") {
              const evt = msg as SdkRateLimitEvent;
              if (evt.rate_limit_info.status === "rejected") {
                rateLimitText = buildRateLimitText(evt.rate_limit_info.resetsAt);
                accumulatedText += `\n${rateLimitText}`;
                // Set error immediately so the rate limit text is in result.error
                // regardless of whether the result message arrived before or after.
                isError = true;
                errorMessage = rateLimitText;
                this.logger.debug(`sdk-launch: rate limited — resetsAt=${evt.rate_limit_info.resetsAt ?? "unknown"}`);
              }
            }
          }
        })(),
        timeoutPromise,
      ];

      if (idleTimeoutPromise) {
        racePromises.push(idleTimeoutPromise);
      }

      await Promise.race(racePromises);
    } catch (err) {
      isError = true;
      errorMessage = err instanceof Error ? err.message : String(err);
      // If a rate limit rejection was received before the process exited,
      // use the rate limit text so the orchestrator can detect and parse it.
      if (rateLimitText) {
        errorMessage = rateLimitText;
      }
      this.logger.debug(`sdk-launch: error — ${errorMessage}`);
      
      // If idle timeout or error, mark PID as abandoned for cleanup
      if (this.currentPid !== null && this.processTracker) {
        if (errorMessage?.includes("Session idle for")) {
          this.logger.debug(`sdk-launch: idle timeout — marking PID ${this.currentPid} as abandoned`);
          this.processTracker.abandonPid(this.currentPid);
        } else {
          // Other error — also abandon (process might still be running)
          this.logger.debug(`sdk-launch: error — marking PID ${this.currentPid} as abandoned`);
          this.processTracker.abandonPid(this.currentPid);
        }
        this.currentPid = null;
      }
    } finally {
      if (timeoutHandle !== null) {
        clearTimeout(timeoutHandle);
        timeoutHandle = null;
      }
      if (idleTimeoutHandle !== null) {
        clearTimeout(idleTimeoutHandle);
        idleTimeoutHandle = null;
      }
      if (this.activeChannel && !this.activeChannel.isClosed()) {
        this.activeChannel.close();
      }
      this.activeChannel = null;
      
      // If session completed normally, mark PID as exited
      if (this.currentPid !== null && this.processTracker && !isError) {
        this.processTracker.onProcessExit(this.currentPid);
        this.currentPid = null;
      }
    }

    const endTime = this.clock.now();
    const durationMs = endTime.getTime() - startTime.getTime();

    const rawOutput = resultOutput || accumulatedText;

    this.logger.verbose(
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
          this.logger.verbose(`  [${entry.type}] ${entry.content}`);
          onLogEntry?.(entry);
          
          // Try to extract PID from system message if available
          // Note: SDK may not expose PID, so this might be null
          // If PID is available in the message, register it
          const pid = this.extractPidFromMessage(msg);
          if (pid !== null && this.processTracker) {
            this.currentPid = pid;
            this.processTracker.registerPid(pid);
            this.logger.debug(`sdk-launch: registered PID ${pid} from system init`);
          }
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
          this.logger.verbose(`  [${entry.type}] ${entry.content}`);
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
        this.logger.verbose(`  [${entry.type}] ${entry.content}`);
        onLogEntry?.(entry);
        break;
      }
      default:
        break;
    }
  }

  /**
   * Try to extract PID from SDK message
   * Returns null if PID is not available (SDK may not expose it)
   */
  private extractPidFromMessage(msg: SdkMessage): number | null {
    // Check if message has PID field (SDK might expose it)
    const msgAny = msg as { pid?: number; session_id?: string; [key: string]: unknown };
    if (typeof msgAny.pid === "number") {
      return msgAny.pid;
    }
    // SDK might not expose PID — return null
    return null;
  }

  private isContinueError(result: ClaudeSessionResult): boolean {
    const msg = (result.error ?? "").toLowerCase();
    return msg.includes("no session") || msg.includes("continue") || msg.includes("no conversation");
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

const MONTH_NAMES = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/**
 * Builds a rate limit text string from a Unix timestamp (in seconds).
 * Matches the format expected by parseRateLimitReset: "resets Feb 14, 10am (UTC)".
 */
export function buildRateLimitText(resetsAtSeconds: number | undefined): string {
  if (!resetsAtSeconds) {
    return "You've hit your limit · rate limited";
  }
  const d = new Date(resetsAtSeconds * 1000);
  const month = MONTH_NAMES[d.getUTCMonth()];
  const day = d.getUTCDate();
  const h = d.getUTCHours();
  const ampm = h >= 12 ? "pm" : "am";
  const displayH = h % 12 || 12;
  return `You've hit your limit · resets ${month} ${day}, ${displayH}${ampm} (UTC)`;
}
