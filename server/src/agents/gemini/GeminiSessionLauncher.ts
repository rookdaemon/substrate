import type { IProcessRunner } from "../claude/IProcessRunner";
import type { IClock } from "../../substrate/abstractions/IClock";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "../claude/ISessionLauncher";

const DEFAULT_MODEL = "gemini-2.5-pro";

/**
 * ISessionLauncher implementation that invokes the Gemini CLI for agent
 * reasoning sessions (Ego / Subconscious / Superego / Id).
 *
 * CLI mapping (from `gemini --help`, v0.30.0):
 *   systemPrompt  → prepended to the message as a "SYSTEM INSTRUCTIONS:" block
 *   message       → -p "<message>"
 *   model         → -m <model>
 *   continueSession → -r (resume latest session)
 *   --yolo        → auto-approve all tool calls (required for MCP in headless mode)
 */
export class GeminiSessionLauncher implements ISessionLauncher {
  private readonly model: string;

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    model?: string,
  ) {
    this.model = model ?? DEFAULT_MODEL;
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    const modelToUse = options?.model ?? this.model;

    // Gemini CLI has no --system-prompt flag; prepend system instructions to
    // the user message so the model still receives them.
    const fullMessage = request.systemPrompt
      ? `SYSTEM INSTRUCTIONS:\n${request.systemPrompt}\n\n---\n\n${request.message}`
      : request.message;

    // --yolo auto-approves MCP tool calls; without it, headless mode (-p)
    // cannot execute tools and Gemini falls back to emitting tool_code blocks.
    const args: string[] = ["-p", fullMessage, "-m", modelToUse, "--yolo"];

    if (options?.continueSession) {
      args.push("-r");
    }

    try {
      const result = await this.processRunner.run("gemini", args, {
        cwd: options?.cwd,
        timeoutMs: options?.timeoutMs,
      });

      const durationMs = this.clock.now().getTime() - startMs;
      const success = result.exitCode === 0;

      return {
        rawOutput: result.stdout,
        exitCode: result.exitCode,
        durationMs,
        success,
        error: success ? undefined : result.stderr || `gemini exited with code ${result.exitCode}`,
      };
    } catch (err) {
      return {
        rawOutput: "",
        exitCode: 1,
        durationMs: this.clock.now().getTime() - startMs,
        success: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }
}
