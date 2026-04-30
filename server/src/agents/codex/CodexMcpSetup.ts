import type { IProcessRunner } from "../claude/IProcessRunner";
import type { ILogger } from "../../logging";

/**
 * Registers an HTTP MCP server in Codex CLI configuration.
 *
 * Idempotent: safe to call on every startup; re-registration is handled by
 * removing the existing entry first and re-adding with the current URL.
 */
export class CodexMcpSetup {
  constructor(
    private readonly processRunner: IProcessRunner,
    private readonly logger: ILogger,
  ) {}

  async register(serverName: string, mcpUrl: string): Promise<void> {
    this.logger.debug(`codex-mcp-setup: registering "${serverName}" MCP server at ${mcpUrl}`);

    try {
      await this.processRunner.run("codex", ["mcp", "remove", serverName]);
    } catch {
      // Not registered yet — that is fine.
    }

    try {
      const result = await this.processRunner.run("codex", [
        "mcp",
        "add",
        serverName,
        "--url",
        mcpUrl,
      ]);
      if (result.exitCode === 0) {
        this.logger.debug(`codex-mcp-setup: "${serverName}" registered successfully`);
      } else {
        this.logger.warn(
          `codex-mcp-setup: "codex mcp add" exited with code ${result.exitCode}: ${result.stderr}`,
        );
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(`codex-mcp-setup: registration failed: ${msg}`);
    }
  }
}
