import type { IProcessRunner } from "../claude/IProcessRunner";
import type { IClock } from "../../substrate/abstractions/IClock";
import type { ILogger } from "../../logging";
import type {
  ClaudeSessionRequest,
  ClaudeSessionResult,
  ISessionLauncher,
  LaunchOptions,
  ProcessLogEntry,
  SessionUsage,
} from "../claude/ISessionLauncher";

export type PiShellMode = "json" | "print";
export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh";

export interface PiSessionLauncherConfig {
  /** Pi LLM provider name passed as `--provider`, e.g. openai, anthropic, google, ollama. */
  provider?: string;
  /** Pi model pattern/id passed as `--model`. */
  model?: string;
  /** Noninteractive shell mode. `json` preserves event parsing; `print` is a plain fallback. */
  mode?: PiShellMode;
  /** Optional Pi reasoning level passed as `--thinking`. */
  thinking?: PiThinkingLevel;
  /** Optional Pi session directory passed as `--session-dir`. */
  sessionDir?: string;
  /** Local Substrate API token exposed to Pi direct HTTP tool calls as SUBSTRATE_API_TOKEN. */
  apiToken?: string;
  /** Provider API key environment for Pi, e.g. OPENAI_API_KEY or GEMINI_API_KEY. */
  providerEnv?: Record<string, string | undefined>;
  /** Default process wall-clock cap for Pi sessions. LaunchOptions.timeoutMs overrides this. */
  defaultTimeoutMs?: number;
  /** Default no-output cap for Pi sessions. LaunchOptions.idleTimeoutMs overrides this. */
  defaultIdleTimeoutMs?: number;
  /** Maximum characters stored for each process-log entry. */
  maxLoggedTextChars?: number;
  /** Minimum assistant text length before it is worth logging as a text entry. */
  minLoggedTextChars?: number;
}

const MAX_PROCESS_LOG_CONTENT_CHARS = 2_000;
const MIN_PROCESS_LOG_TEXT_CHARS = 8;
const DEFAULT_PI_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PI_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * ISessionLauncher implementation that invokes Pi Coding Agent as an external
 * shell process for cognitive role sessions.
 *
 * Preferred mode is `pi --mode json`, which emits JSONL events and exits. That
 * keeps Substrate in control of process lifecycle while preserving Pi's native
 * read/write/edit/bash tool loop. Pi has no built-in MCP dependency; substrate
 * prompts point Pi at direct HTTP/CLI tool surfaces instead.
 */
export class PiSessionLauncher implements ISessionLauncher {
  private readonly mode: PiShellMode;
  private readonly maxProcessLogContentChars: number;
  private readonly minProcessLogTextChars: number;
  private readonly defaultTimeoutMs: number;
  private readonly defaultIdleTimeoutMs: number;

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly config: PiSessionLauncherConfig = {},
    private readonly logger?: ILogger,
  ) {
    this.mode = config.mode ?? "json";
    this.maxProcessLogContentChars = Math.max(1, config.maxLoggedTextChars ?? MAX_PROCESS_LOG_CONTENT_CHARS);
    this.minProcessLogTextChars = Math.max(1, config.minLoggedTextChars ?? MIN_PROCESS_LOG_TEXT_CHARS);
    this.defaultTimeoutMs = Math.max(1, config.defaultTimeoutMs ?? DEFAULT_PI_TIMEOUT_MS);
    this.defaultIdleTimeoutMs = Math.max(1, config.defaultIdleTimeoutMs ?? DEFAULT_PI_IDLE_TIMEOUT_MS);
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    const modelToUse = options?.model ?? this.config.model;
    const stdin = this.buildPrompt(request);
    const args = this.buildArgs(options, modelToUse);

    this.logger?.debug(
      `pi-launch: mode=${this.mode} provider=${this.config.provider ?? "default"} model=${modelToUse ?? "default"} cwd=${options?.cwd ?? process.cwd()}`,
    );

    try {
      const result = await this.processRunner.run("pi", args, {
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs ?? this.defaultTimeoutMs,
        idleTimeoutMs: options?.idleTimeoutMs ?? this.defaultIdleTimeoutMs,
        stdin,
        onStdout: options?.onLogEntry && this.mode === "json"
          ? this.createJsonLogAdapter(options.onLogEntry)
          : undefined,
        env: this.buildEnvironment(),
      });

      const durationMs = this.clock.now().getTime() - startMs;
      const success = result.exitCode === 0;
      const parsed = this.mode === "json"
        ? this.parseJsonOutput(result.stdout, modelToUse)
        : { rawOutput: result.stdout, usage: undefined };

      if (!success) {
        this.logger?.debug(`pi-launch: failed exit=${result.exitCode} stderr=${result.stderr || "none"}`);
      } else {
        this.logger?.debug(`pi-launch: completed in ${durationMs}ms`);
      }

      return {
        rawOutput: parsed.rawOutput,
        exitCode: result.exitCode,
        durationMs,
        success,
        error: success ? undefined : result.stderr || `pi exited with code ${result.exitCode}`,
        usage: parsed.usage,
      };
    } catch (err) {
      this.logger?.debug(`pi-launch: error — ${err instanceof Error ? err.message : String(err)}`);
      return {
        rawOutput: "",
        exitCode: 1,
        durationMs: this.clock.now().getTime() - startMs,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildPrompt(request: ClaudeSessionRequest): string {
    return request.systemPrompt
      ? `SYSTEM INSTRUCTIONS:\n${request.systemPrompt}\n\n---\n\n${request.message}`
      : request.message;
  }

  private buildEnvironment(): Record<string, string | undefined> | undefined {
    const env = {
      ...this.config.providerEnv,
      ...(this.config.apiToken ? { SUBSTRATE_API_TOKEN: this.config.apiToken } : {}),
    };
    return Object.keys(env).length > 0 ? env : undefined;
  }

  private buildArgs(
    options: LaunchOptions | undefined,
    model: string | undefined,
  ): string[] {
    const args: string[] = [];
    if (this.mode === "json") {
      args.push("--mode", "json");
    } else {
      args.push("-p");
    }

    if (this.config.provider) {
      args.push("--provider", this.config.provider);
    }
    if (model) {
      args.push("--model", model);
    }
    if (this.config.thinking) {
      args.push("--thinking", this.config.thinking);
    }
    if (this.config.sessionDir) {
      args.push("--session-dir", this.config.sessionDir);
    }
    if (options?.continueSession && options.persistSession !== false) {
      args.push("--continue");
    } else if (options?.persistSession === false) {
      args.push("--no-session");
    }
    return args;
  }

  private createJsonLogAdapter(onLogEntry: (entry: ProcessLogEntry) => void): (chunk: string) => void {
    let buffer = "";
    let lastTextEntry = "";
    return (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = this.parseJsonLine(line);
        if (!event) continue;
        for (const entry of this.logEntriesFromEvent(event)) {
          if (entry.type === "text") {
            if (entry.content === lastTextEntry) continue;
            lastTextEntry = entry.content;
          }
          onLogEntry(entry);
        }
      }
    };
  }

  private parseJsonOutput(stdout: string, model: string | undefined): { rawOutput: string; usage?: SessionUsage } {
    let finalText = "";
    let usageCandidate: Record<string, unknown> | undefined;

    for (const line of stdout.split(/\r?\n/)) {
      const event = this.parseJsonLine(line);
      if (!event) continue;

      usageCandidate = this.findUsageCandidate(event) ?? usageCandidate;
      const text = this.finalTextFromEvent(event);
      if (text) finalText = text;
    }

    const usage = usageCandidate ? this.toSessionUsage(usageCandidate, model) : undefined;
    return {
      rawOutput: finalText || stdout,
      usage,
    };
  }

  private parseJsonLine(line: string): Record<string, unknown> | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed as Record<string, unknown> : null;
    } catch {
      return null;
    }
  }

  private logEntriesFromEvent(event: Record<string, unknown>): ProcessLogEntry[] {
    const type = event.type;
    if (type === "message_update") {
      return [];
    }
    if (type === "message") {
      return this.logEntriesFromMessageEvent(event);
    }
    const finalText = this.finalTextFromEvent(event);
    if (finalText && !this.looksLikeJsonObject(finalText)) {
      return this.textLogEntries(finalText);
    }
    if (type === "tool_execution_start") {
      return [{
        type: "tool_use",
        content: this.toProcessLogContent(JSON.stringify({
          tool: event.toolName,
          args: event.args,
        })),
      }];
    }
    if (type === "tool_execution_update" || type === "tool_execution_end") {
      const result = event.partialResult ?? event.result;
      return [{ type: "tool_result", content: this.toProcessLogContent(this.toolResultText(result)) }];
    }
    if (type === "agent_start" || type === "agent_end" || type === "turn_start" || type === "turn_end") {
      return [{ type: "status", content: String(type) }];
    }
    return [];
  }

  private logEntriesFromMessageEvent(event: Record<string, unknown>): ProcessLogEntry[] {
    const message = this.recordField(event, "message");
    if (!message) return [];

    const role = this.stringField(message, "role");
    if (role === "toolResult") {
      const text = this.messageContentText(message);
      return text ? [{ type: "tool_result", content: this.toProcessLogContent(text) }] : [];
    }

    if (role !== "assistant") return [];

    const toolCallEntries = this.toolCallEntries(message);
    if (toolCallEntries.length > 0) {
      // Pi assistant messages commonly pair short narration with tool calls.
      // The tool call itself is the useful process-log event; logging both
      // creates repeated low-signal "text" rows in the UI.
      return toolCallEntries;
    }

    const text = this.cleanAssistantText(this.messageText(message));
    if (!text || this.looksLikeJsonObject(text)) return [];
    return this.textLogEntries(text);
  }

  private finalTextFromEvent(event: Record<string, unknown>): string {
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      return this.lastAssistantText(event.messages);
    }
    if (event.type === "message" && event.message && typeof event.message === "object") {
      return this.messageText(event.message as Record<string, unknown>);
    }
    if ((event.type === "message_end" || event.type === "turn_end") && event.message && typeof event.message === "object") {
      return this.messageText(event.message as Record<string, unknown>);
    }
    return "";
  }

  private lastAssistantText(messages: unknown[]): string {
    for (let i = messages.length - 1; i >= 0; i--) {
      const message = messages[i];
      if (!message || typeof message !== "object") continue;
      const text = this.messageText(message as Record<string, unknown>);
      if (text) return text;
    }
    return "";
  }

  private messageText(message: Record<string, unknown>): string {
    const role = this.stringField(message, "role");
    const type = this.stringField(message, "type");
    if (role && role !== "assistant" && type !== "assistant") return "";
    return this.messageContentText(message);
  }

  private messageContentText(message: Record<string, unknown>): string {
    if (typeof message.text === "string") return message.text;
    if (typeof message.content === "string") return message.content;
    if (!Array.isArray(message.content)) return "";

    return message.content
      .map((part) => {
        if (typeof part === "string") return part;
        if (!part || typeof part !== "object") return "";
        const record = part as Record<string, unknown>;
        const partType = this.stringField(record, "type") ?? "";
        if (partType.includes("thinking")) return "";
        if (partType === "toolCall") return "";
        return this.stringField(record, "text")
          ?? this.stringField(record, "content")
          ?? "";
      })
      .filter(Boolean)
      .join("");
  }

  private toolCallEntries(message: Record<string, unknown>): ProcessLogEntry[] {
    if (!Array.isArray(message.content)) return [];
    const entries: ProcessLogEntry[] = [];
    for (const part of message.content) {
      if (!part || typeof part !== "object") continue;
      const record = part as Record<string, unknown>;
      if (this.stringField(record, "type") !== "toolCall") continue;
      entries.push({
        type: "tool_use",
        content: this.toProcessLogContent(JSON.stringify({
          tool: this.stringField(record, "name") ?? "unknown",
          args: record.arguments ?? {},
        })),
      });
    }
    return entries;
  }

  private cleanAssistantText(text: string): string {
    return text
      .replace(/<think>[\s\S]*?<\/think>/gi, "")
      .replace(/<\/?think>/gi, "")
      .trim();
  }

  private looksLikeJsonObject(text: string): boolean {
    const trimmed = text.trim();
    if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return false;
    try {
      JSON.parse(trimmed);
      return true;
    } catch {
      return false;
    }
  }

  private toProcessLogContent(content: string): string {
    if (content.length <= this.maxProcessLogContentChars) return content;
    return `${content.slice(0, this.maxProcessLogContentChars)}\n...[truncated ${content.length - this.maxProcessLogContentChars} chars]`;
  }

  private textLogEntries(text: string): ProcessLogEntry[] {
    const cleaned = this.cleanAssistantText(text);
    return this.shouldLogAssistantText(cleaned)
      ? [{ type: "text", content: this.toProcessLogContent(cleaned) }]
      : [];
  }

  private shouldLogAssistantText(text: string): boolean {
    const trimmed = text.trim();
    if (trimmed.length < this.minProcessLogTextChars) return false;
    const words = trimmed.split(/\s+/).filter(Boolean);
    const hasSentenceSignal = /[.!?:;]/.test(trimmed);
    const compactSingleToken = words.length <= 1 && /^[A-Za-z0-9_-]+$/.test(trimmed);
    return !compactSingleToken || hasSentenceSignal || trimmed.length > 40;
  }

  private findUsageCandidate(event: Record<string, unknown>): Record<string, unknown> | undefined {
    const direct = this.recordField(event, "usage") ?? this.recordField(event, "tokens") ?? this.recordField(event, "cost");
    if (direct) return direct;
    const message = this.recordField(event, "message");
    return message
      ? this.recordField(message, "usage") ?? this.recordField(message, "tokens") ?? undefined
      : undefined;
  }

  private toSessionUsage(rawUsage: Record<string, unknown>, model: string | undefined): SessionUsage | undefined {
    const promptTokens = this.numberField(rawUsage, "input")
      ?? this.numberField(rawUsage, "inputTokens")
      ?? this.numberField(rawUsage, "input_tokens")
      ?? this.numberField(rawUsage, "promptTokens");
    const cachedInputTokens = this.numberField(rawUsage, "cacheRead")
      ?? this.numberField(rawUsage, "cache_read")
      ?? this.numberField(rawUsage, "cachedInputTokens")
      ?? this.numberField(rawUsage, "cached_input_tokens");
    const completionTokens = this.numberField(rawUsage, "output")
      ?? this.numberField(rawUsage, "outputTokens")
      ?? this.numberField(rawUsage, "output_tokens")
      ?? this.numberField(rawUsage, "completionTokens");
    const totalTokens = this.numberField(rawUsage, "total")
      ?? this.numberField(rawUsage, "totalTokens")
      ?? this.numberField(rawUsage, "total_tokens")
      ?? (
        promptTokens !== undefined || completionTokens !== undefined
          ? (promptTokens ?? 0) + (completionTokens ?? 0)
          : undefined
      );
    const costUsd = this.numberField(rawUsage, "cost")
      ?? this.numberField(rawUsage, "costUsd")
      ?? this.numberField(rawUsage, "cost_usd")
      ?? this.numberField(this.recordField(rawUsage, "cost"), "total");

    if (
      promptTokens === undefined &&
      cachedInputTokens === undefined &&
      completionTokens === undefined &&
      totalTokens === undefined &&
      costUsd === undefined
    ) {
      return undefined;
    }

    return {
      provider: "pi",
      ...(model ? { model } : {}),
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(promptTokens !== undefined
        ? { nonCachedInputTokens: Math.max(0, promptTokens - (cachedInputTokens ?? 0)) }
        : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      costKnown: costUsd !== undefined,
      costEstimate: false,
      billingSource: costUsd !== undefined ? "cli_usage" : "unknown",
      telemetrySource: "pi-json-event-stream",
    };
  }

  private toolResultText(result: unknown): string {
    if (!result || typeof result !== "object") return String(result ?? "");
    const record = result as Record<string, unknown>;
    if (Array.isArray(record.content)) {
      return record.content
        .map((part) => {
          if (typeof part === "string") return part;
          if (!part || typeof part !== "object") return "";
          return this.stringField(part as Record<string, unknown>, "text") ?? "";
        })
        .filter(Boolean)
        .join("\n");
    }
    return JSON.stringify(record);
  }

  private recordField(record: Record<string, unknown> | undefined, field: string): Record<string, unknown> | undefined {
    const value = record?.[field];
    return value && typeof value === "object" && !Array.isArray(value)
      ? value as Record<string, unknown>
      : undefined;
  }

  private stringField(record: Record<string, unknown> | undefined, field: string): string | undefined {
    const value = record?.[field];
    return typeof value === "string" ? value : undefined;
  }

  private numberField(record: Record<string, unknown>, field: string): number | undefined {
    const value = record[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
}
