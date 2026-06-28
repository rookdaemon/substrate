import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { BackendType } from "./types";
import type { BackendResult, ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import { buildPrompt } from "./prompt";

export interface PiCliBackendConfig {
  provider?: string;
  model?: string;
  thinking?: "off" | "minimal" | "low" | "medium" | "high" | "xhigh";
  sessionDir?: string;
  apiToken?: string;
  providerEnv?: Record<string, string | undefined>;
  defaultTimeoutMs?: number;
  defaultIdleTimeoutMs?: number;
}

const DEFAULT_PI_CODE_TIMEOUT_MS = 15 * 60 * 1000;
const DEFAULT_PI_CODE_IDLE_TIMEOUT_MS = 3 * 60 * 1000;

/**
 * Infer the provider name from a model string that uses the "provider/model"
 * convention (e.g. "openrouter/moonshotai/kimi-k2.6:floor" → "openrouter").
 * Returns undefined when the model has no "/" separator or is unset.
 *
 * Mirrors the inference logic in ShellIndependenceService.piProvider() so that
 * PiCliBackend passes --provider consistently even when config only specifies
 * a model string.
 */
export function inferProviderFromModel(model: string | undefined): string | undefined {
  if (!model) return undefined;
  const prefix = model.split("/")[0];
  return prefix !== model ? prefix : undefined;
}

/**
 * PiCliBackend — routes code-dispatch through the portable Pi shell instead of
 * a proprietary commercial CLI. Provider/model/key settings are passed in from
 * Substrate config so code-dispatch matches the active Pi/Kimi/OpenRouter route.
 *
 * This backend is the shell-independence migration target for code dispatch:
 * it replaces the Codex CLI default with a local, open-source tool that can
 * target self-hosted (Ollama), remote API (OpenRouter), or other providers
 * without requiring a separate proprietary binary per provider.
 */
export class PiCliBackend implements ICodeBackend {
  readonly name: BackendType = "pi";

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly configOrModel: PiCliBackendConfig | string = {},
  ) {
    if (typeof configOrModel === "string") {
      this.config = { model: configOrModel };
    } else {
      this.config = configOrModel;
    }
  }

  private config: PiCliBackendConfig;

  async invoke(spec: string, context: SubstrateSlice): Promise<BackendResult> {
    const prompt = buildPrompt(spec, context);
    const startMs = this.clock.now().getTime();
    const args = this.buildArgs();

    try {
      const result = await this.processRunner.run("pi", args, {
        cwd: context.cwd,
        stdin: prompt,
        env: this.buildEnvironment(),
        timeoutMs: this.config.defaultTimeoutMs ?? DEFAULT_PI_CODE_TIMEOUT_MS,
        idleTimeoutMs: this.config.defaultIdleTimeoutMs ?? DEFAULT_PI_CODE_IDLE_TIMEOUT_MS,
      });
      // On failure, include stderr so caller can diagnose errors (e.g. 401 auth failures).
      const output = result.exitCode === 0
        ? result.stdout
        : [result.stdout, result.stderr].filter((s) => s.length > 0).join("\n") || "";
      return {
        success: result.exitCode === 0,
        output,
        exitCode: result.exitCode,
        durationMs: this.clock.now().getTime() - startMs,
      };
    } catch (err) {
      return {
        success: false,
        output: err instanceof Error ? err.message : String(err),
        exitCode: 1,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }
  }

  private buildArgs(): string[] {
    const args: string[] = ["-p"];
    // Infer provider from model prefix ("openrouter/model" → "--provider openrouter")
    // when not explicitly set. Mirrors ShellIndependenceService.piProvider().
    const provider = this.config.provider ?? inferProviderFromModel(this.config.model);
    pushOption(args, "--provider", provider);
    pushOption(args, "--model", this.config.model);
    pushOption(args, "--thinking", this.config.thinking);
    pushOption(args, "--session-dir", this.config.sessionDir);
    args.push("--no-session");
    return args;
  }

  private buildEnvironment(): Record<string, string | undefined> | undefined {
    const env = {
      ...this.config.providerEnv,
      ...(this.config.apiToken ? { SUBSTRATE_API_TOKEN: this.config.apiToken } : {}),
    };
    return Object.keys(env).length > 0 ? env : undefined;
  }
}

/** Push a CLI flag + value pair only when value is defined and non-empty. */
function pushOption(args: string[], flag: string, value: string | undefined): void {
  if (value) {
    args.push(flag, value);
  }
}
