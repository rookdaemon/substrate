import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { BackendType } from "./types";
import type { BackendResult, ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import { buildPrompt } from "./prompt";

/**
 * PiCliBackend — routes code-dispatch through the portable Pi shell instead of
 * a proprietary commercial CLI. Pi is provider-agnostic; the provider and model
 * are determined by Pi's own config/env, not hard-coded here.
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
    private readonly model?: string,
  ) {}

  async invoke(spec: string, context: SubstrateSlice): Promise<BackendResult> {
    const prompt = buildPrompt(spec, context);
    const startMs = this.clock.now().getTime();
    const args = ["-p"];
    if (this.model) {
      args.push("--model", this.model);
    }

    try {
      const result = await this.processRunner.run("pi", args, { cwd: context.cwd, stdin: prompt });
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
}
