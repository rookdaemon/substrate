import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createCodeDispatchMcpServer,
  addCodeDispatchTools,
} from "../../src/mcp/CodeDispatchMcpServer";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { CodeDispatcher } from "../../src/code-dispatch/CodeDispatcher";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import type { ICodeBackend, SubstrateSlice, BackendResult } from "../../src/code-dispatch/ICodeBackend";
import type { BackendType, CodeResult } from "../../src/code-dispatch/types";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Controllable in-memory backend */
class InMemoryCodeBackend implements ICodeBackend {
  readonly name: BackendType;
  private responses: BackendResult[] = [];

  constructor(name: BackendType = "claude") {
    this.name = name;
  }

  enqueue(result: BackendResult): void {
    this.responses.push(result);
  }

  async invoke(_spec: string, _context: SubstrateSlice): Promise<BackendResult> {
    const response = this.responses.shift();
    if (!response) throw new Error("InMemoryCodeBackend: no responses enqueued");
    return response;
  }
}

function makeDispatcher(
  backends: Map<BackendType, ICodeBackend> = new Map(),
  defaultBackend: BackendType = "auto",
): CodeDispatcher {
  const fs = new InMemoryFileSystem();
  const processRunner = new InMemoryProcessRunner();
  const clock = new FixedClock(new Date("2025-01-01T00:00:00Z"));
  return new CodeDispatcher(fs, processRunner, "/substrate/substrate", backends, clock, defaultBackend);
}

function successBackend(name: BackendType = "claude"): InMemoryCodeBackend {
  const b = new InMemoryCodeBackend(name);
  b.enqueue({ success: true, output: "done", exitCode: 0, durationMs: 10 });
  return b;
}

async function buildClient(dispatcher: CodeDispatcher): Promise<{
  client: Client;
  cleanup: () => Promise<void>;
}> {
  const server = createCodeDispatchMcpServer(dispatcher);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test-client", version: "1.0.0" });
  await client.connect(clientTransport);
  return {
    client,
    cleanup: async () => { await client.close(); },
  };
}

function parseResult(result: { content: Array<{ type: string; text?: string }> }): unknown {
  const text = result.content.find((c) => c.type === "text")?.text ?? "";
  return JSON.parse(text);
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("CodeDispatchMcpServer", () => {
  let client: Client;
  let cleanup: () => Promise<void>;

  afterEach(async () => {
    await cleanup?.();
  });

  // -------------------------------------------------------------------------
  // invoke tool — happy paths
  // -------------------------------------------------------------------------
  describe("invoke tool — success paths", () => {
    it("returns a result with success:true for claude backend", async () => {
      const claude = successBackend("claude");
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Fix the bug", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(data.success).toBe(true);
      expect(data.backendUsed).toBe("claude");
    });

    it("returns a result with success:true for copilot backend", async () => {
      const copilot = successBackend("copilot");
      const dispatcher = makeDispatcher(
        new Map<BackendType, ICodeBackend>([["copilot", copilot]]),
      );
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Refactor utils", backend: "copilot", files: ["src/utils.ts"] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(data.success).toBe(true);
      expect(data.backendUsed).toBe("copilot");
    });

    it("passes spec to the backend", async () => {
      const claude = new InMemoryCodeBackend("claude");
      const captured: string[] = [];
      const origInvoke = claude.invoke.bind(claude);
      claude.invoke = async (spec, context) => {
        captured.push(spec);
        return origInvoke(spec, context);
      };
      claude.enqueue({ success: true, output: "ok", exitCode: 0, durationMs: 5 });

      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      await client.callTool({
        name: "invoke",
        arguments: { spec: "Add unit tests", backend: "claude", files: [] },
      });
      expect(captured[0]).toBe("Add unit tests");
    });

    it("result includes output field", async () => {
      const claude = new InMemoryCodeBackend("claude");
      claude.enqueue({ success: true, output: "All done", exitCode: 0, durationMs: 10 });
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Task", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(data.output).toBe("All done");
    });

    it("result includes durationMs", async () => {
      const claude = successBackend("claude");
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Task", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(typeof data.durationMs).toBe("number");
    });

    it("result includes filesChanged array", async () => {
      const claude = successBackend("claude");
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Task", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(Array.isArray(data.filesChanged)).toBe(true);
    });
  });

  // -------------------------------------------------------------------------
  // invoke tool — error handling
  // -------------------------------------------------------------------------
  describe("invoke tool — error handling", () => {
    it("returns success:false when backend is not registered", async () => {
      const dispatcher = makeDispatcher(new Map()); // no backends
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Task", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(data.success).toBe(false);
      expect(data.error).toMatch(/not registered/i);
    });

    it("returns success:false when backend throws", async () => {
      const failBackend = new InMemoryCodeBackend("claude");
      failBackend.invoke = async () => { throw new Error("backend crashed"); };
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", failBackend]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Task", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as { success: boolean; error: string };
      expect(data.success).toBe(false);
      expect(data.error).toContain("backend crashed");
    });

    it("returns success:false when backend exits with non-zero code", async () => {
      const claude = new InMemoryCodeBackend("claude");
      claude.enqueue({ success: false, output: "compile error", exitCode: 1, durationMs: 5 });
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      const result = await client.callTool({
        name: "invoke",
        arguments: { spec: "Task", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(data.success).toBe(false);
    });
  });

  // -------------------------------------------------------------------------
  // addCodeDispatchTools composition
  // -------------------------------------------------------------------------
  describe("addCodeDispatchTools composition", () => {
    it("adds invoke tool to an existing McpServer", async () => {
      const claude = successBackend("claude");
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));

      const server = new McpServer({ name: "composite", version: "1.0.0" });
      addCodeDispatchTools(server, dispatcher);

      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const c = new Client({ name: "t", version: "1" });
      await c.connect(ct);
      cleanup = async () => { await c.close(); };

      const tools = await c.listTools();
      expect(tools.tools.map((t) => t.name)).toContain("invoke");
    });

    it("invoke tool is callable on the composite server", async () => {
      const claude = successBackend("claude");
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));

      const server = new McpServer({ name: "composite", version: "1.0.0" });
      addCodeDispatchTools(server, dispatcher);

      const [ct, st] = InMemoryTransport.createLinkedPair();
      await server.connect(st);
      const c = new Client({ name: "t", version: "1" });
      await c.connect(ct);
      cleanup = async () => { await c.close(); };

      const result = await c.callTool({
        name: "invoke",
        arguments: { spec: "Fix tests", backend: "claude", files: [] },
      });
      const data = parseResult(result as Parameters<typeof parseResult>[0]) as CodeResult;
      expect(data.success).toBe(true);
    });

    it("createCodeDispatchMcpServer creates a standalone server with only invoke", async () => {
      const claude = successBackend("claude");
      const dispatcher = makeDispatcher(new Map<BackendType, ICodeBackend>([["claude", claude]]));
      ({ client, cleanup } = await buildClient(dispatcher));

      const tools = await client.listTools();
      const names = tools.tools.map((t) => t.name);
      expect(names).toEqual(["invoke"]);
    });
  });
});
