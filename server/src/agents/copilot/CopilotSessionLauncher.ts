import { randomUUID } from "node:crypto";
import type { IProcessRunner } from "../claude/IProcessRunner";
import type { IClock } from "../../substrate/abstractions/IClock";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "../claude/ISessionLauncher";

const DEFAULT_MODEL = "claude-sonnet-4.5";

/**
 * ISessionLauncher implementation that invokes the Copilot CLI for agent
 * reasoning sessions (Ego / Subconscious / Superego / Id).
 *
 * CLI mapping:
 *   systemPrompt    → prepended to the message as a "SYSTEM INSTRUCTIONS:" block
 *   message         → -p "<message>"
 *   model           → --model <model>
 *   continueSession → --resume <uuid> keyed by cwd (isolated per role workspace)
 *   --allow-all-tools → auto-approve all tool calls (required for headless mode)
 *
 * Session continuity: unlike Claude, Copilot sessions are stored globally in
 * ~/.copilot/session-state/<uuid>/ rather than inside the working directory.
 * We generate a UUID per cwd on the first continueSession call and reuse it
 * for subsequent calls, giving each role its own isolated conversation thread.
 */
export class CopilotSessionLauncher implements ISessionLauncher {
  private readonly model: string;
  private readonly sessionIds = new Map<string, string>();
  private readonly mcpServers: Record<string, { type: string; url: string }>;

  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly clock: IClock,
    model?: string,
    private readonly generateUUID: () => string = randomUUID,
    private readonly additionalDirs: string[] = [],
    mcpServers?: Record<string, { type: string; url: string }>,
  ) {
    this.model = model ?? DEFAULT_MODEL;
    this.mcpServers = mcpServers ?? {};
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    const modelToUse = options?.model ?? this.model;

    // Copilot CLI has no --system-prompt flag; prepend system instructions to
    // the user message so the model still receives them.
    const fullMessage = request.systemPrompt
      ? `SYSTEM INSTRUCTIONS:\n${request.systemPrompt}\n\n---\n\n${request.message}`
      : request.message;

    const args: string[] = ["-p", fullMessage, "--allow-all-tools", "--silent", "--model", modelToUse];

    if (options?.cwd) {
      args.push("--add-dir", options.cwd);
    }

    for (const dir of this.additionalDirs) {
      args.push("--add-dir", dir);
    }

    if (options?.continueSession && options.cwd) {
      if (!this.sessionIds.has(options.cwd)) {
        this.sessionIds.set(options.cwd, this.generateUUID());
      }
      args.push("--resume", this.sessionIds.get(options.cwd)!);
    }

    // Pass MCP server config inline via --additional-mcp-config
    const mcpKeys = Object.keys(this.mcpServers);
    if (mcpKeys.length > 0) {
      const mcpConfig = { mcpServers: this.mcpServers };
      args.push("--additional-mcp-config", JSON.stringify(mcpConfig));
    }

    try {
      const result = await this.processRunner.run("copilot", args, {
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
        error: success ? undefined : result.stderr || `copilot exited with code ${result.exitCode}`,
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
