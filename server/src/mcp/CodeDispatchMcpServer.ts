import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type { CodeDispatcher } from "../code-dispatch/CodeDispatcher";
import type { BackendType } from "../code-dispatch/types";

/**
 * Register the code-dispatch `invoke` tool on an existing MCP server.
 *
 * Kept separate from createTinyBusMcpServer so it can be composed alongside
 * TinyBus tools on the shared /mcp HTTP endpoint.
 */
export function addCodeDispatchTools(server: McpServer, dispatcher: CodeDispatcher): void {
  server.tool(
    "invoke",
    "Dispatch a coding task with scoped coding context. Auto/default dispatch is Codex-local-first; legacy shell backends require an explicit backend override.",
    {
      spec: z.string().describe("Task specification in natural language"),
      backend: z.enum(["copilot", "claude", "codex", "gemini", "auto"]).default("auto").describe("Backend to use; auto routes to the local Codex tool path"),
      files: z.array(z.string()).describe("Source file paths to include as context"),
      testCommand: z.string().optional().describe("Test gate command (default: npm test)"),
      model: z.string().optional().describe("Model override for backends that support model selection"),
      cwd: z.string().optional().describe("Working directory for the task"),
    },
    async ({ spec, backend, files, testCommand, model, cwd }) => {
      try {
        const result = await dispatcher.dispatch({
          spec,
          backend: backend as BackendType,
          files: files ?? [],
          testCommand,
          model,
          cwd,
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify(result),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );
}

/**
 * Create a standalone MCP server with only the code-dispatch `invoke` tool.
 * Useful for testing or for scenarios where a dedicated endpoint is preferred.
 */
export function createCodeDispatchMcpServer(dispatcher: CodeDispatcher): McpServer {
  const server = new McpServer({
    name: "code_dispatch",
    version: "1.0.0",
  });
  addCodeDispatchTools(server, dispatcher);
  return server;
}
