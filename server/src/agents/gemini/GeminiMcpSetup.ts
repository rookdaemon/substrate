import type { IProcessRunner } from "../claude/IProcessRunner";
import type { ILogger } from "../../logging";

/**
 * Registers the TinyBus MCP server in Gemini CLI's MCP configuration.
 * Required for Subconscious cycles running via GeminiSessionLauncher to
 * invoke mcp__tinybus__* tools.
 *
 * Idempotent: safe to call on every startup; re-registration is handled
 * by removing the existing entry first and re-adding with the current URL.
 */
export class GeminiMcpSetup {
  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly logger: ILogger,
  ) {}

  async register(serverName: string, mcpUrl: string): Promise<void> {
    this.logger.debug(`gemini-mcp-setup: registering "${serverName}" MCP server at ${mcpUrl}`);

    // Remove any existing registration first (ignore errors — may not be registered)
    try {
      await this.processRunner.run("gemini", ["mcp", "remove", serverName, "-y"]);
    } catch {
      // Not registered yet — that is fine
    }

    try {
      const result = await this.processRunner.run("gemini", [
        "mcp",
        "add",
        serverName,
        "--url",
        mcpUrl,
      ]);
      if (result.exitCode === 0) {
        this.logger.debug(`gemini-mcp-setup: "${serverName}" registered successfully`);
      } else {
        this.logger.warn(
          `gemini-mcp-setup: "gemini mcp add" exited with code ${result.exitCode}: ${result.stderr}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`gemini-mcp-setup: registration failed: ${msg}`);
    }
  }
}
