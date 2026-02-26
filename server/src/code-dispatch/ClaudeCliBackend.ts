import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { BackendType } from "./types";
import type { BackendResult, ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import { buildPrompt } from "./prompt";

const DEFAULT_MODEL = "claude-sonnet-4-5";

export class ClaudeCliBackend implements ICodeBackend {
  readonly name: BackendType = "claude";

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
        "claude",
        ["--print", "-p", prompt, "--model", model],
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
