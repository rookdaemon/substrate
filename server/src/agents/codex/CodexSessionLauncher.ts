import type { IProcessRunner } from "../claude/IProcessRunner";
import type { IClock } from "../../substrate/abstractions/IClock";
import type { ILogger } from "../../logging";
import type { ReasoningEffort } from "../reasoningEffort";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
  ProcessLogEntry,
  SessionUsage,
} from "../claude/ISessionLauncher";

/**
 * ISessionLauncher implementation that invokes the Codex CLI for agent
 * reasoning sessions (Ego / Subconscious / Superego / Id).
 *
 * CLI mapping (from `codex exec --help`):
 *   systemPrompt    -> prepended to the message as a "SYSTEM INSTRUCTIONS:" block
 *   message         -> codex exec "<message>"
 *   model           -> -m <model> when a non-Claude model is supplied
 *   effort          -> -c model_reasoning_effort="<effort>"
 *   cwd             -> -C <cwd> and process cwd
 *   additionalDirs  -> --add-dir <dir>
 *   continueSession -> intentionally ignored; Substrate injects complete file context each turn
 *   bypass approvals -> required for non-interactive MCP tool execution
 *   --json          -> parse final agent message and turn token usage from JSONL events
 */
export class CodexSessionLauncher implements ISessionLauncher {
  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly model?: string,
    private readonly logger?: ILogger,
    private readonly effort?: ReasoningEffort,
  ) {}

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    const modelToUse = this.resolveModel(options?.model ?? this.model);
    const effortToUse = options?.effort ?? this.effort;
    const fullMessage = request.systemPrompt
      ? `SYSTEM INSTRUCTIONS:\n${request.systemPrompt}\n\n---\n\n${request.message}`
      : request.message;

    const cwd = options?.cwd;
    const args = this.buildExecArgs(fullMessage, modelToUse, effortToUse, cwd, options?.additionalDirs);

    this.logger?.debug(`codex-launch: exec model=${modelToUse ?? "default"} effort=${effortToUse ?? "default"} cwd=${cwd ?? process.cwd()}`);

    try {
      const result = await this.processRunner.run("codex", args, {
        cwd,
        timeoutMs: options?.timeoutMs,
        idleTimeoutMs: options?.idleTimeoutMs,
        stdin: fullMessage,
        onStdout: options?.onLogEntry
          ? this.createJsonLogAdapter(options.onLogEntry)
          : undefined,
      });

      const durationMs = this.clock.now().getTime() - startMs;
      const success = result.exitCode === 0;
      const parsed = this.parseJsonOutput(result.stdout, modelToUse);
      if (!success) {
        this.logger?.debug(`codex-launch: failed exit=${result.exitCode} stderr=${result.stderr || "none"}`);
      } else {
        this.logger?.debug(`codex-launch: completed in ${durationMs}ms`);
      }

      return {
        rawOutput: parsed.rawOutput,
        exitCode: result.exitCode,
        durationMs,
        success,
        error: success ? undefined : result.stderr || `codex exited with code ${result.exitCode}`,
        usage: parsed.usage,
      };
    } catch (err) {
      this.logger?.debug(`codex-launch: error — ${err instanceof Error ? err.message : String(err)}`);
      return {
        rawOutput: "",
        exitCode: 1,
        durationMs: this.clock.now().getTime() - startMs,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }

  private buildExecArgs(
    message: string,
    model: string | undefined,
    effort: ReasoningEffort | undefined,
    cwd: string | undefined,
    additionalDirs: string[] | undefined,
  ): string[] {
    const args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
      "--json",
      "--color",
      "never",
      "--skip-git-repo-check",
      "--ephemeral",
    ];
    if (model) {
      args.push("-m", model);
    }
    if (effort) {
      args.push("-c", `model_reasoning_effort="${effort}"`);
    }
    if (cwd) {
      args.push("-C", cwd);
    }
    for (const dir of additionalDirs ?? []) {
      args.push("--add-dir", dir);
    }
    args.push("-");
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
        const text = this.agentMessageText(event);
        if (text !== null) {
          onLogEntry({ type: "text", content: text });
        }
      }
    };
  }

  private parseJsonOutput(stdout: string, model: string | undefined): { rawOutput: string; usage?: SessionUsage } {
    const finalMessages: string[] = [];
    let usage: SessionUsage | undefined;

    for (const line of stdout.split(/\r?\n/)) {
      const event = this.parseJsonLine(line);
      if (!event) continue;

      const text = this.agentMessageText(event);
      if (text !== null) {
        finalMessages.push(text);
      }
      if (event.type === "turn.completed" && event.usage && typeof event.usage === "object") {
        usage = this.toSessionUsage(event.usage as Record<string, unknown>, model);
      }
    }

    return {
      rawOutput: finalMessages.length > 0 ? finalMessages.join("\n") : stdout,
      usage,
    };
  }

  private parseJsonLine(line: string): Record<string, unknown> | null {
    const trimmed = line.trim();
    if (!trimmed) return null;
    try {
      const parsed = JSON.parse(trimmed);
      return parsed && typeof parsed === "object" ? parsed : null;
    } catch {
      return null;
    }
  }

  private agentMessageText(event: Record<string, unknown>): string | null {
    if (event.type !== "item.completed") return null;
    const item = event.item;
    if (!item || typeof item !== "object") return null;
    const record = item as Record<string, unknown>;
    return record.type === "agent_message" && typeof record.text === "string"
      ? record.text
      : null;
  }

  private toSessionUsage(rawUsage: Record<string, unknown>, model: string | undefined): SessionUsage {
    const promptTokens = this.numberField(rawUsage, "input_tokens");
    const cachedInputTokens = this.numberField(rawUsage, "cached_input_tokens");
    const completionTokens = this.numberField(rawUsage, "output_tokens");
    const reasoningOutputTokens = this.numberField(rawUsage, "reasoning_output_tokens");
    const nonCachedInputTokens =
      promptTokens !== undefined
        ? Math.max(0, promptTokens - (cachedInputTokens ?? 0))
        : undefined;
    const totalTokens =
      promptTokens !== undefined || completionTokens !== undefined
        ? (promptTokens ?? 0) + (completionTokens ?? 0)
        : undefined;
    const costUsd = this.estimateCostUsd(model, nonCachedInputTokens, cachedInputTokens, completionTokens);

    return {
      provider: "codex",
      ...(model ? { model } : {}),
      ...(promptTokens !== undefined ? { promptTokens } : {}),
      ...(cachedInputTokens !== undefined ? { cachedInputTokens } : {}),
      ...(nonCachedInputTokens !== undefined ? { nonCachedInputTokens } : {}),
      ...(completionTokens !== undefined ? { completionTokens } : {}),
      ...(reasoningOutputTokens !== undefined ? { reasoningOutputTokens } : {}),
      ...(totalTokens !== undefined ? { totalTokens } : {}),
      ...(costUsd !== undefined ? { costUsd } : {}),
      costKnown: false,
      costEstimate: costUsd !== undefined,
      billingSource: costUsd !== undefined ? "static_estimate" : "unknown",
      telemetrySource: "codex-exec-json",
    };
  }

  private numberField(record: Record<string, unknown>, field: string): number | undefined {
    const value = record[field];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }

  private estimateCostUsd(
    model: string | undefined,
    nonCachedInputTokens: number | undefined,
    cachedInputTokens: number | undefined,
    outputTokens: number | undefined,
  ): number | undefined {
    const rates = this.codexDollarRates(model);
    if (!rates) return undefined;
    return (
      ((nonCachedInputTokens ?? 0) * rates.inputUsdPerMillion +
        (cachedInputTokens ?? 0) * rates.cachedInputUsdPerMillion +
        (outputTokens ?? 0) * rates.outputUsdPerMillion) /
      1_000_000
    );
  }

  private codexDollarRates(model: string | undefined): { inputUsdPerMillion: number; cachedInputUsdPerMillion: number; outputUsdPerMillion: number } | null {
    switch (model) {
      case "gpt-5.5":
        return { inputUsdPerMillion: 5, cachedInputUsdPerMillion: 0.5, outputUsdPerMillion: 30 };
      case "gpt-5.4":
        return { inputUsdPerMillion: 2.5, cachedInputUsdPerMillion: 0.25, outputUsdPerMillion: 15 };
      case "gpt-5.4-mini":
        return { inputUsdPerMillion: 0.75, cachedInputUsdPerMillion: 0.075, outputUsdPerMillion: 4.5 };
      default:
        return null;
    }
  }

  private resolveModel(model: string | undefined): string | undefined {
    if (!model) return undefined;
    // Resolved config defaults to Claude model names. When Codex is selected
    // without an explicit Codex model, let the Codex CLI use its own profile.
    if (model.startsWith("claude-")) return undefined;
    return model;
  }
}
