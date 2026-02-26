import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { BackendType } from "./types";
import type { BackendResult, ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import { buildPrompt } from "./prompt";

const DEFAULT_MODEL = "gemini-2.5-pro";

/**
 * ICodeBackend implementation that invokes the Gemini CLI for code dispatch
 * tasks (same pattern as ClaudeCliBackend).
 *
 * CLI mapping (from `gemini --help`, v0.30.0):
 *   prompt  → -p "<CODING_CONTEXT + spec>"
 *   model   → -m <model>
 *   cwd     → process working directory
 */
export class GeminiCliBackend implements ICodeBackend {
  readonly name: BackendType = "gemini";

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly model?: string,
  ) {}

  async invoke(spec: string, context: SubstrateSlice): Promise<BackendResult> {
    const prompt = buildPrompt(spec, context);
    const model = this.model ?? DEFAULT_MODEL;

    const startMs = this.clock.now().getTime();
    try {
      const result = await this.processRunner.run(
        "gemini",
        ["-p", prompt, "-m", model],
        { cwd: context.cwd },
      );
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
