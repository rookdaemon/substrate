import type { IProcessRunner } from "../agents/claude/IProcessRunner";
import type { IClock } from "../substrate/abstractions/IClock";
import type { BackendType } from "./types";
import type { BackendResult, ICodeBackend, SubstrateSlice } from "./ICodeBackend";
import { buildPrompt } from "./prompt";

/** Timeout for copilot invocations in ms (5 minutes — agentic tasks take longer). */
const COPILOT_TIMEOUT_MS = 5 * 60 * 1000;

export class CopilotBackend implements ICodeBackend {
  readonly name: BackendType = "copilot";

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    private readonly model?: string,
  ) {}

  async invoke(spec: string, context: SubstrateSlice): Promise<BackendResult> {
    const prompt = buildPrompt(spec, context);
    const startMs = this.clock.now().getTime();

    const args = ["-p", prompt, "--allow-all-tools", "--silent", "--add-dir", context.cwd];
    if (this.model) args.push("--model", this.model);

    try {
      const result = await this.processRunner.run("copilot", args, {
        cwd: context.cwd,
        timeoutMs: COPILOT_TIMEOUT_MS,
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
}
