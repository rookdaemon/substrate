import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { BackendType } from "./types";
import type { BackendResult, ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import { buildPrompt } from "./prompt";

export class CodexCliBackend implements ICodeBackend {
  readonly name: BackendType = "codex";

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly model?: string,
  ) {}

  async invoke(spec: string, context: SubstrateSlice): Promise<BackendResult> {
    const prompt = buildPrompt(spec, context);
    const startMs = this.clock.now().getTime();
    const args = ["exec", "--full-auto", "--color", "never", "--skip-git-repo-check"];
    if (this.model && !this.model.startsWith("claude-")) {
      args.push("-m", this.model);
    }
    args.push("-C", context.cwd, prompt);

    try {
      const result = await this.processRunner.run("codex", args, { cwd: context.cwd });
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
