import * as http from "node:http";
import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { CanaryLogger, ConvMdStats } from "../../src/evaluation/CanaryLogger";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { Id } from "../../src/agents/roles/Id";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { TaskClassifier } from "../../src/agents/TaskClassifier";

async function post(port: number, path: string): Promise<{ status: number; body: unknown; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: "127.0.0.1", port, path, method: "POST" }, (res) => {
      let data = "";
      res.on("data", (chunk) => { data += chunk; });
      res.on("end", () => {
        try {
          resolve({ status: res.statusCode ?? 0, body: JSON.parse(data), headers: res.headers });
        } catch {
          resolve({ status: res.statusCode ?? 0, body: data, headers: res.headers });
        }
      });
    });
    req.on("error", reject);
    req.end();
  });
}

async function setupSubstrateFiles(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
  await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nSome memories");
  await fs.writeFile("/substrate/HABITS.md", "# Habits\n\nSome habits");
  await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nSome skills");
  await fs.writeFile("/substrate/VALUES.md", "# Values\n\nBe good");
  await fs.writeFile("/substrate/ID.md", "# Id\n\nCore identity");
  await fs.writeFile("/substrate/SECURITY.md", "# Security\n\nStay safe");
  await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\nOur mission");
  await fs.writeFile("/substrate/SUPEREGO.md", "# Superego\n\nRules here");
  await fs.writeFile("/substrate/CLAUDE.md", "# Claude\n\nConfig here");
  await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
  await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
}

describe("POST /api/canary/run", () => {
  let server: LoopHttpServer;
  let port: number;
  let fs: InMemoryFileSystem;
  let canaryLogger: CanaryLogger;
  let launcher: InMemorySessionLauncher;
  let id: Id;
  const canaryPath = "/data/canary-log.jsonl";

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    await setupSubstrateFiles(fs);

    canaryLogger = new CanaryLogger(fs, canaryPath);

    launcher = new InMemorySessionLauncher();
    const config = new SubstrateConfig("/substrate");
    const reader = new SubstrateFileReader(fs, config);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);
    const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
    const clock = new FixedClock(new Date("2026-03-11T16:00:00.000Z"));

    id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier);

    server = new LoopHttpServer();
    server.setEventSink(new InMemoryEventSink(), clock);
    server.setCanaryRoute(id, canaryLogger, "claude");

    port = await server.listen(0);
  });

  afterEach(async () => {
    await server.close();
  });

  it("returns 200 with CanaryRecord and appends to canary-log.jsonl", async () => {
    launcher.enqueueSuccess(JSON.stringify({
      goalCandidates: [
        { title: "Goal A", description: "Safe", priority: "high", confidence: 85 },
      ],
    }));

    const res = await post(port, "/api/canary/run");

    expect(res.status).toBe(200);
    const record = res.body as Record<string, unknown>;
    expect(record.trigger).toBe("api");
    expect(record.launcher).toBe("claude");
    expect(record.candidateCount).toBe(1);
    expect(record.pass).toBe(true);
    expect(record.parseErrors).toBe(0);
    expect(record.highPriorityConfidence).toBe(85);
    expect(record.cycle).toBe(-1);

    // Verify record is appended to canary-log.jsonl
    const content = await fs.readFile(canaryPath);
    const written = JSON.parse(content.trim());
    expect(written.trigger).toBe("api");
    expect(written.candidateCount).toBe(1);
  });

  it("includes convMd normalization fields when convMdReader is configured", async () => {
    launcher.enqueueSuccess(JSON.stringify({
      goalCandidates: [
        { title: "Goal A", description: "Safe", priority: "high", confidence: 85 },
      ],
    }));

    const convStats: ConvMdStats = { lines: 81, kb: 4.2 };
    const convMdReader = jest.fn().mockResolvedValue(convStats);

    server.setCanaryRoute(id, canaryLogger, "claude", convMdReader);

    const res = await post(port, "/api/canary/run");
    expect(res.status).toBe(200);
    const record = res.body as Record<string, unknown>;
    expect(record.convMdLines).toBe(81);
    expect(record.convMdKb).toBe(4.2);
    expect(typeof record.cPerLine).toBe("number");
    expect(typeof record.cPerKb).toBe("number");
  });

  it("returns 429 on second call within 55-minute rate limit window", async () => {
    launcher.enqueueSuccess(JSON.stringify({ goalCandidates: [] }));
    launcher.enqueueSuccess(JSON.stringify({ goalCandidates: [] }));

    const first = await post(port, "/api/canary/run");
    expect(first.status).toBe(200);

    const second = await post(port, "/api/canary/run");
    expect(second.status).toBe(429);
    const body = second.body as Record<string, unknown>;
    expect(body.error).toBe("Rate limited");
    expect(typeof body.retryAfterSeconds).toBe("number");
    expect(body.retryAfterSeconds as number).toBeGreaterThan(0);
  });
});
