import * as http from "node:http";
import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { TinyBus } from "../../src/tinybus/core/TinyBus";
import { MemoryProvider } from "../../src/tinybus/providers/MemoryProvider";
import { CodeDispatcher } from "../../src/code-dispatch/CodeDispatcher";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import type { IMetricsService, LlmSessionMetric, MetricsQuery, UsageSummary } from "../../src/metrics/IMetricsService";
import type { IShellIndependenceService, ShellIndependenceSnapshot } from "../../src/shell/ShellIndependenceService";
import type { ICodeBackend, BackendResult, SubstrateSlice } from "../../src/code-dispatch/ICodeBackend";
import type { BackendType } from "../../src/code-dispatch/types";

async function request<TBody = unknown>(
  port: number,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: TBody }> {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = http.request({
      host: "127.0.0.1",
      port,
      path,
      method,
      headers: payload
        ? { "Content-Type": "application/json", "Content-Length": Buffer.byteLength(payload) }
        : undefined,
    }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data) as TBody });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data as TBody });
        }
      });
    });
    req.on("error", reject);
    req.end(payload);
  });
}

class RecordingMetricsService implements IMetricsService {
  queries: MetricsQuery[] = [];

  async recordLlmSession(_metric: LlmSessionMetric): Promise<void> {}

  async query(query: MetricsQuery): Promise<Record<string, unknown>[]> {
    this.queries.push(query);
    return [{ ok: true, sql: query.sql }];
  }

  async summarizeUsage(windowHours: number): Promise<UsageSummary> {
    return {
      windowHours,
      sessions: 1,
      promptTokens: 2,
      cachedInputTokens: 0,
      nonCachedInputTokens: 2,
      completionTokens: 3,
      reasoningOutputTokens: 0,
      totalTokens: 5,
      costUsd: 0.01,
      estimatedCostUsd: 0,
      knownCostUsd: 0.01,
      unknownCostSessions: 0,
    };
  }
}

class StaticBackend implements ICodeBackend {
  readonly name: BackendType = "codex";
  calls: Array<{ spec: string; context: SubstrateSlice }> = [];

  async invoke(spec: string, context: SubstrateSlice): Promise<BackendResult> {
    this.calls.push({ spec, context });
    return { success: true, output: "done", exitCode: 0, durationMs: 1 };
  }
}

function makeShellSnapshot(): ShellIndependenceSnapshot {
  return {
    generatedAt: "2026-05-08T00:00:00.000Z",
    inventory: {
      activeCognitiveRoute: {
        id: "cognitive:pi",
        label: "cognitive via pi",
        provider: "pi",
        kind: "portable-shell",
        status: "active",
        risk: "medium",
        evidence: ["sessionLauncher: pi"],
      },
      codeDispatchRoute: {
        id: "code:codex",
        label: "code dispatch via codex",
        provider: "codex",
        kind: "commercial-shell",
        status: "default",
        risk: "high",
        evidence: ["defaultCodeBackend: auto"],
      },
      idRoute: {
        id: "id:pi",
        label: "id via pi",
        provider: "pi",
        kind: "portable-shell",
        status: "active",
        risk: "medium",
        evidence: ["id launcher: pi"],
      },
      deterministicRoutes: [],
      fallbackRoutes: [],
      staticShellReferences: [],
      notes: [],
    },
    scorecard: {
      score: 66,
      grade: "C",
      riskLevel: "medium",
      activeLauncher: "pi",
      activeLauncherKind: "portable-shell",
      codeDispatchDefault: "codex",
      commercialShellCount: 1,
      remoteApiCount: 1,
      deterministicRouteCount: 4,
      blockers: ["default code dispatch depends on commercial shell: codex"],
      nextActions: ["Replace default code dispatch with a portable backend or require explicit backend selection."],
    },
    compactReport: ["Shell independence score: 66/100 (C, medium risk)"],
  };
}

class StaticShellIndependenceService implements IShellIndependenceService {
  private snapshot = makeShellSnapshot();

  async refresh(): Promise<ShellIndependenceSnapshot> {
    return this.snapshot;
  }

  getLastSnapshot(): ShellIndependenceSnapshot | null {
    return this.snapshot;
  }
}

describe("direct HTTP tool routes", () => {
  let server: LoopHttpServer;
  let port: number;
  let tinyBus: TinyBus | undefined;

  afterEach(async () => {
    if (server) await server.close();
    if (tinyBus) await tinyBus.stop();
  });

  it("exposes usage summary and read-only metrics query without MCP", async () => {
    const metrics = new RecordingMetricsService();
    server = new LoopHttpServer();
    server.setUsageMetrics(metrics);
    port = await server.listen(0);

    const summary = await request<{ summary: UsageSummary }>(port, "GET", "/api/metrics/usage-summary?windowHours=12");
    expect(summary.status).toBe(200);
    expect(summary.body.summary.windowHours).toBe(12);

    const query = await request<{ rows: Record<string, unknown>[] }>(port, "POST", "/api/metrics/query", { sql: "SELECT * FROM usage_daily", maxRows: 5 });
    expect(query.status).toBe(200);
    expect(query.body.rows).toEqual([{ ok: true, sql: "SELECT * FROM usage_daily" }]);
    expect(metrics.queries[0]).toEqual({ sql: "SELECT * FROM usage_daily", params: undefined, maxRows: 5 });
  });

  it("publishes Agora send messages through direct HTTP", async () => {
    tinyBus = new TinyBus();
    const provider = new MemoryProvider("agora-outbound", ["agora.send"]);
    tinyBus.registerProvider(provider);
    await tinyBus.start();
    server = new LoopHttpServer();
    server.setTinyBus(tinyBus);
    port = await server.listen(0);

    const response = await request<{ success: boolean }>(port, "POST", "/api/agora/send", {
      to: "stefan",
      text: "hello",
      inReplyTo: "env-1",
    });

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    const sent = provider.getSentMessages();
    expect(sent).toHaveLength(1);
    expect(sent[0].type).toBe("agora.send");
    expect(sent[0].payload).toMatchObject({
      to: ["stefan"],
      inReplyTo: "env-1",
      payload: { text: "hello" },
    });
  });

  it("dispatches code work through direct HTTP", async () => {
    const fs = new InMemoryFileSystem();
    const runner = new InMemoryProcessRunner();
    const clock = new FixedClock(new Date("2026-05-07T00:00:00.000Z"));
    const backend = new StaticBackend();
    const dispatcher = new CodeDispatcher(
      fs,
      runner,
      "/substrate/substrate",
      new Map<BackendType, ICodeBackend>([["codex", backend]]),
      clock,
      "codex",
    );
    runner.enqueue({ stdout: "src/a.ts\n", stderr: "", exitCode: 0 });
    server = new LoopHttpServer();
    server.setCodeDispatcher(dispatcher);
    port = await server.listen(0);

    const response = await request<{ success: boolean; backendUsed: BackendType; output: string; filesChanged: string[] }>(port, "POST", "/api/code-dispatch/invoke", {
      spec: "change it",
      backend: "auto",
      files: [],
      cwd: "/repo",
    });

    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      success: true,
      backendUsed: "codex",
      output: "done",
      filesChanged: ["src/a.ts"],
    });
    expect(backend.calls[0].spec).toBe("change it");
  });

  it("exposes shell-independence inventory through direct HTTP", async () => {
    server = new LoopHttpServer();
    server.setShellIndependenceService(new StaticShellIndependenceService());
    port = await server.listen(0);

    const response = await request<{ success: boolean; snapshot: ShellIndependenceSnapshot }>(port, "GET", "/api/shell-independence");

    expect(response.status).toBe(200);
    expect(response.body.success).toBe(true);
    expect(response.body.snapshot.scorecard).toMatchObject({
      activeLauncher: "pi",
      codeDispatchDefault: "codex",
      score: 66,
    });
  });
});
