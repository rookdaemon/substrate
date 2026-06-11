import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { ReasoningEffort } from "../agents/reasoningEffort";
import type { BackendType } from "./types";
import type { BackendResult, CodeBackendOptions, ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import { buildPrompt } from "./prompt";

export class CodexCliBackend implements ICodeBackend {
  readonly name: BackendType = "codex";

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly model?: string,
    private readonly effort?: ReasoningEffort,
  ) {}

  async invoke(spec: string, context: SubstrateSlice, options?: CodeBackendOptions): Promise<BackendResult> {
    const prompt = buildPrompt(spec, context);
    const model = this.resolveModel(options?.model ?? this.model);
    const effort = options?.effort ?? this.effort;
    const startMs = this.clock.now().getTime();
    const args = [
      "exec",
      "--dangerously-bypass-approvals-and-sandbox",
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
    args.push("-C", context.cwd, "-");

    try {
      const result = await this.processRunner.run("codex", args, { cwd: context.cwd, stdin: prompt });
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

  private resolveModel(model: string | undefined): string | undefined {
    if (!model) return undefined;
    if (model.startsWith("claude-")) return undefined;
    return model;
  }
}
