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
    private readonly config: PiCliBackendConfig = {},
  ) {}

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
      return {
        success: result.exitCode === 0,
        output: result.stdout,
        exitCode: result.exitCode,
        durationMs: this.clock.now().getTime() - startMs,
      };
    } catch {
      return {
        success: false,
        output: "",
        exitCode: 1,
        durationMs: this.clock.now().getTime() - startMs,
      };
    }
  }

  private buildArgs(): string[] {
    const args = ["-p"];
    if (this.config.provider) {
      args.push("--provider", this.config.provider);
    }
    if (this.config.model) {
      args.push("--model", this.config.model);
    }
    if (this.config.thinking) {
      args.push("--thinking", this.config.thinking);
    }
    if (this.config.sessionDir) {
      args.push("--session-dir", this.config.sessionDir);
    }
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
