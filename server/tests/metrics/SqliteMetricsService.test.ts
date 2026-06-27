import * as fs from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { SqliteMetricsService } from "../../src/metrics/SqliteMetricsService";

const [major, minor] = process.versions.node.split(".").map(Number);
const hasSqlite = major > 22 || (major === 22 && minor >= 5);
const describeIfSqlite = hasSqlite ? describe : describe.skip;

describeIfSqlite("SqliteMetricsService", () => {
  let tmpDir: string;
  let service: SqliteMetricsService;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "substrate-metrics-"));
    service = new SqliteMetricsService(path.join(tmpDir, "metrics.sqlite"));
  });

  afterEach(() => {
    service.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it("records LLM sessions and supports SQL aggregation", async () => {
    await service.recordLlmSession({
      id: "session-1",
      startedAt: "2026-05-01T10:00:00.000Z",
      completedAt: "2026-05-01T10:00:05.000Z",
      role: "EGO",
      operation: "decide",
      provider: "codex",
      model: "gpt-5.5",
      promptTokens: 100,
      cachedInputTokens: 40,
      nonCachedInputTokens: 60,
      completionTokens: 10,
      reasoningOutputTokens: 2,
      totalTokens: 110,
      costUsd: 0.001,
      costKnown: false,
      costEstimate: true,
      billingSource: "static_estimate",
      telemetrySource: "codex-exec-json",
      success: true,
      durationMs: 5_000,
    });
    await service.recordLlmSession({
      id: "session-2",
      startedAt: "2026-05-01T11:00:00.000Z",
      completedAt: "2026-05-01T11:00:02.000Z",
      role: "SUBCONSCIOUS",
      operation: "execute",
      provider: "codex",
      model: "gpt-5.5",
      promptTokens: 200,
      totalTokens: 230,
      costKnown: false,
      costEstimate: false,
      billingSource: "unknown",
      telemetrySource: "codex-exec-json",
      success: true,
      durationMs: 2_000,
    });

    const rows = await service.query<{ role: string; tokens: number; sessions: number }>({
      sql: `
        SELECT role, sum(total_tokens) AS tokens, count(*) AS sessions
        FROM llm_sessions
        GROUP BY role
        ORDER BY role
      `,
    });

    expect(rows).toEqual([
      { role: "EGO", tokens: 110, sessions: 1 },
      { role: "SUBCONSCIOUS", tokens: 230, sessions: 1 },
    ]);
  });

  it("rejects write and multi-statement queries", async () => {
    await expect(service.query({ sql: "DELETE FROM llm_sessions" })).rejects.toThrow("Only SELECT");
    await expect(service.query({ sql: "SELECT 1; SELECT 2" })).rejects.toThrow("Multiple SQL statements");
    await expect(service.query({ sql: "SELECT * FROM pragma_database_list" })).rejects.toThrow("read-only");
  });

  it("caps result rows", async () => {
    const rows = await service.query({ sql: "SELECT 1 AS n UNION ALL SELECT 2 AS n", maxRows: 1 });

    expect(rows).toEqual([{ n: 1 }]);
  });
});
