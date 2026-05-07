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

export interface PiSessionLauncherConfig {
  /** Pi LLM provider name passed as `--provider`, e.g. openai, anthropic, google, ollama. */
  provider?: string;
  /** Pi model pattern/id passed as `--model`. */
  model?: string;
  /** Noninteractive shell mode. `json` preserves event parsing; `print` is a plain fallback. */
  mode?: PiShellMode;
  /** Optional Pi session directory passed as `--session-dir`. */
  sessionDir?: string;
  /** Local Substrate API token exposed to Pi direct HTTP tool calls as SUBSTRATE_API_TOKEN. */
  apiToken?: string;
}

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

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly config: PiSessionLauncherConfig = {},
    private readonly logger?: ILogger,
  ) {
    this.mode = config.mode ?? "json";
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    const modelToUse = options?.model ?? this.config.model;
    const args = this.buildArgs(request, options, modelToUse);

    this.logger?.debug(
      `pi-launch: mode=${this.mode} provider=${this.config.provider ?? "default"} model=${modelToUse ?? "default"} cwd=${options?.cwd ?? process.cwd()}`,
    );

    try {
      const result = await this.processRunner.run("pi", args, {
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs,
        idleTimeoutMs: options?.idleTimeoutMs,
        onStdout: options?.onLogEntry && this.mode === "json"
          ? this.createJsonLogAdapter(options.onLogEntry)
          : undefined,
        env: this.config.apiToken
          ? { SUBSTRATE_API_TOKEN: this.config.apiToken }
          : undefined,
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

  private buildArgs(
    request: ClaudeSessionRequest,
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
    if (this.config.sessionDir) {
      args.push("--session-dir", this.config.sessionDir);
    }
    if (options?.continueSession && options.persistSession !== false) {
      args.push("--continue");
    } else if (options?.persistSession === false) {
      args.push("--no-session");
    }
    if (request.systemPrompt) {
      args.push("--append-system-prompt", request.systemPrompt);
    }
    args.push(request.message);
    return args;
  }

  private createJsonLogAdapter(onLogEntry: (entry: ProcessLogEntry) => void): (chunk: string) => void {
    let buffer = "";
    return (chunk) => {
      buffer += chunk;
      const lines = buffer.split(/\r?\n/);
      buffer = lines.pop() ?? "";
      for (const line of lines) {
        const event = this.parseJsonLine(line);
        if (!event) continue;
        for (const entry of this.logEntriesFromEvent(event)) {
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
      const delta = this.recordField(event, "assistantMessageEvent");
      const deltaType = typeof delta?.type === "string" ? delta.type : "";
      const text = this.stringField(delta, "delta") ?? this.stringField(delta, "content");
      if (!text) return [];
      if (deltaType === "thinking_delta") return [{ type: "thinking", content: text }];
      if (deltaType === "toolcall_delta") return [{ type: "tool_use", content: text }];
      return [{ type: "text", content: text }];
    }
    if (type === "tool_execution_start") {
      return [{
        type: "tool_use",
        content: JSON.stringify({
          tool: event.toolName,
          args: event.args,
        }),
      }];
    }
    if (type === "tool_execution_update" || type === "tool_execution_end") {
      const result = event.partialResult ?? event.result;
      return [{ type: "tool_result", content: this.toolResultText(result) }];
    }
    if (type === "agent_start" || type === "agent_end" || type === "turn_start" || type === "turn_end") {
      return [{ type: "status", content: String(type) }];
    }
    return [];
  }

  private finalTextFromEvent(event: Record<string, unknown>): string {
    if (event.type === "agent_end" && Array.isArray(event.messages)) {
      return this.lastAssistantText(event.messages);
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
        return this.stringField(record, "text")
          ?? this.stringField(record, "content")
          ?? "";
      })
      .filter(Boolean)
      .join("");
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
      ?? this.numberField(rawUsage, "cost_usd");

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
