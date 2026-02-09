import * as http from "node:http";
import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { ImmediateTimer } from "../../src/loop/ImmediateTimer";
import { defaultLoopConfig } from "../../src/loop/types";
import { InMemoryLogger } from "../../src/logging";
import { Ego } from "../../src/agents/roles/Ego";
import { Subconscious } from "../../src/agents/roles/Subconscious";
import { Superego } from "../../src/agents/roles/Superego";
import { Id } from "../../src/agents/roles/Id";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../src/substrate/io/FileLock";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../../src/agents/claude/ClaudeSessionLauncher";

function httpFetch(port: number, method: string, path: string, body?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (body) headers["Content-Type"] = "application/json";
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let data = "";
        res.on("data", (chunk) => { data += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body: data }));
      }
    );
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

function createDeps() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
  const runner = new InMemoryProcessRunner();
  const config = new SubstrateConfig("/substrate");
  const reader = new SubstrateFileReader(fs, config);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, config, lock);
  const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker);
  const launcher = new ClaudeSessionLauncher(runner, clock);

  const ego = new Ego(reader, writer, appendWriter, checker, promptBuilder, launcher, clock);
  const subconscious = new Subconscious(reader, writer, appendWriter, checker, promptBuilder, launcher, clock);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock);
  const id = new Id(reader, checker, promptBuilder, launcher, clock);
  const eventSink = new InMemoryEventSink();

  const orchestrator = new LoopOrchestrator(
    ego, subconscious, superego, id, appendWriter, clock,
    new ImmediateTimer(), eventSink, defaultLoopConfig(), new InMemoryLogger()
  );

  return { fs, reader, ego, orchestrator };
}

describe("Integration: HTTP Conversation", () => {
  let server: LoopHttpServer;
  let port: number;
  let deps: ReturnType<typeof createDeps>;

  beforeEach(async () => {
    deps = createDeps();
    await deps.fs.mkdir("/substrate", { recursive: true });
    await deps.fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");

    server = new LoopHttpServer(deps.orchestrator);
    server.setDependencies({ reader: deps.reader, ego: deps.ego });
    port = await server.listen(0);
  });

  afterEach(async () => {
    try { deps.orchestrator.stop(); } catch { /* ignore */ }
    await server.close();
  });

  it("POST /api/conversation/send then GET /api/substrate/CONVERSATION shows the message", async () => {
    // Send a message
    const sendRes = await httpFetch(port, "POST", "/api/conversation/send", JSON.stringify({ message: "Hello from user" }));
    expect(sendRes.status).toBe(200);

    // Read conversation
    const getRes = await httpFetch(port, "GET", "/api/substrate/CONVERSATION");
    expect(getRes.status).toBe(200);

    const body = JSON.parse(getRes.body);
    expect(body.rawMarkdown).toContain("Hello from user");
  });

  it("multiple messages appear in order", async () => {
    await httpFetch(port, "POST", "/api/conversation/send", JSON.stringify({ message: "First message" }));
    await httpFetch(port, "POST", "/api/conversation/send", JSON.stringify({ message: "Second message" }));

    const getRes = await httpFetch(port, "GET", "/api/substrate/CONVERSATION");
    const body = JSON.parse(getRes.body);
    const content = body.rawMarkdown;

    const firstIdx = content.indexOf("First message");
    const secondIdx = content.indexOf("Second message");
    expect(firstIdx).toBeLessThan(secondIdx);
  });
});
