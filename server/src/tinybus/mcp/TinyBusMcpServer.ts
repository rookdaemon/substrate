import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { z } from "zod";
import * as http from "node:http";
import { TinyBus } from "../core/TinyBus";
import { createMessage } from "../core/Message";
import type { Provider } from "../core/Provider";

/**
 * Create an MCP server for TinyBus
 */
export function createTinyBusMcpServer(tinyBus: TinyBus): McpServer {
  const server = new McpServer({
    name: "tinybus",
    version: "1.0.0",
  });

  // Register send_message tool
  server.tool(
    "send_message",
    "Send a message through TinyBus",
    {
      type: z.string().describe("Message type (e.g., 'agent.command.exec')"),
      source: z.string().optional().describe("Source provider ID"),
      destination: z.string().optional().describe("Destination provider ID (omit for broadcast)"),
      payload: z.unknown().optional().describe("Message payload"),
      meta: z.record(z.string(), z.unknown()).optional().describe("Message metadata"),
    },
    async ({ type, source, destination, payload, meta }) => {
      try {
        const message = createMessage({
          type,
          source,
          destination,
          payload,
          meta,
        });

        await tinyBus.publish(message);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                messageId: message.id,
                messageType: message.type,
                timestamp: message.timestamp,
              }),
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

  // Register list_message_types tool
  server.tool(
    "list_message_types",
    "Get all message types supported by registered providers",
    {},
    async () => {
      try {
        const providers = tinyBus.getProviders();
        const messageTypesByProvider: Record<string, string[]> = {};

        for (const provider of providers) {
          const types = provider.getMessageTypes();
          messageTypesByProvider[provider.id] = types;
        }

        // Collect all unique message types
        const allTypes = new Set<string>();
        Object.values(messageTypesByProvider).forEach((types) => {
          types.forEach((type) => allTypes.add(type));
        });

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                providers: messageTypesByProvider,
                allTypes: Array.from(allTypes).sort(),
                totalProviders: providers.length,
              }),
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

  // Register list_providers tool
  server.tool(
    "list_providers",
    "List all registered providers in TinyBus",
    {},
    async () => {
      try {
        const providers = tinyBus.getProviders();
        const providerInfo = providers.map((provider: Provider) => ({
          id: provider.id,
          messageTypes: provider.getMessageTypes(),
          isStarted: tinyBus.isStarted(),
        }));

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                providers: providerInfo,
                totalProviders: providers.length,
                busStarted: tinyBus.isStarted(),
              }),
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

  return server;
}

/**
 * Create an MCP server connected via in-memory transport (for testing)
 */
export function createInMemoryTinyBusMcpServer(tinyBus: TinyBus): {
  server: McpServer;
  clientTransport: InMemoryTransport;
  serverTransport: InMemoryTransport;
} {
  const server = createTinyBusMcpServer(tinyBus);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  return { server, clientTransport, serverTransport };
}

/** Default port for MCP server. Override with PORT environment variable. */
const DEFAULT_PORT = 3000;

/**
 * Start an HTTP MCP server using StreamableHTTP transport
 */
export async function startTinyBusMcpHttpServer(
  tinyBus: TinyBus,
  port: number = Number(process.env.PORT) || DEFAULT_PORT
): Promise<{ server: McpServer; httpServer: http.Server }> {
  const mcpServer = createTinyBusMcpServer(tinyBus);

  // Create transport for stateless mode (each request is independent)
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // Stateless mode
  });

  // Connect MCP server to transport
  await mcpServer.connect(transport);

  // Create HTTP server to handle requests
  const httpServer = http.createServer(async (req, res) => {
    // Health check endpoint
    if (req.url === "/health" && req.method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    // MCP endpoint
    if (req.url === "/mcp" || req.url === "/") {
      try {
        await transport.handleRequest(req, res);
      } catch (error) {
        console.error("Error handling MCP request:", error);
        if (!res.headersSent) {
          res.writeHead(500, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ error: String(error) }));
        }
      }
      return;
    }

    // 404 for other routes
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: "Not found" }));
  });

  return new Promise((resolve) => {
    httpServer.listen(port, () => {
      console.log(`TinyBus MCP server listening on http://localhost:${port}`);
      resolve({ server: mcpServer, httpServer });
    });
  });
}
