import * as http from "node:http";
import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { GovernanceReportStore } from "../../src/evaluation/GovernanceReportStore";
import { HealthCheck } from "../../src/evaluation/HealthCheck";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { ImmediateTimer } from "../../src/loop/ImmediateTimer";
import { LoopState, defaultLoopConfig } from "../../src/loop/types";
import { InMemoryLogger } from "../../src/logging";
import { Ego } from "../../src/agents/roles/Ego";
import { Subconscious } from "../../src/agents/roles/Subconscious";
import { Superego } from "../../src/agents/roles/Superego";
import { Id } from "../../src/agents/roles/Id";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../src/substrate/io/FileLock";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";

interface TestHarness {
  orchestrator: LoopOrchestrator;
  reader: SubstrateFileReader;
  ego: Ego;
  fs: InMemoryFileSystem;
  clock: FixedClock;
  eventSink: InMemoryEventSink;
  timer: ImmediateTimer;
}

function createTestHarness(): TestHarness {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
  const launcher = new InMemorySessionLauncher();
  const config = new SubstrateConfig("/substrate");
  const reader = new SubstrateFileReader(fs, config);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, config, lock);
  const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker);

  const ego = new Ego(reader, writer, appendWriter, checker, promptBuilder, launcher, clock);
  const subconscious = new Subconscious(reader, writer, appendWriter, checker, promptBuilder, launcher, clock);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock);
  const id = new Id(reader, checker, promptBuilder, launcher, clock);

  const timer = new ImmediateTimer();
  const eventSink = new InMemoryEventSink();

  const orchestrator = new LoopOrchestrator(
    ego, subconscious, superego, id, appendWriter, clock, timer, eventSink, defaultLoopConfig(), new InMemoryLogger()
  );

  return { orchestrator, reader, ego, fs, clock, eventSink, timer };
}

function fetch(port: number, method: string, path: string, requestBody?: string): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const headers: Record<string, string> = {};
    if (requestBody) {
      headers["Content-Type"] = "application/json";
    }
    const req = http.request(
      { hostname: "127.0.0.1", port, path, method, headers },
      (res) => {
        let body = "";
        res.on("data", (chunk) => { body += chunk; });
        res.on("end", () => resolve({ status: res.statusCode!, body }));
      }
    );
    req.on("error", reject);
    if (requestBody) {
      req.write(requestBody);
    }
    req.end();
  });
}

describe("LoopHttpServer", () => {
  let orchestrator: LoopOrchestrator;
  let server: LoopHttpServer;
  let port: number;
  let harness: TestHarness;

  beforeEach(async () => {
    harness = createTestHarness();
    orchestrator = harness.orchestrator;
    server = new LoopHttpServer(orchestrator);
    server.setDependencies({ reader: harness.reader, ego: harness.ego });
    port = await server.listen(0); // random port
  });

  afterEach(async () => {
    // Stop orchestrator if running to prevent dangling promises
    try { orchestrator.stop(); } catch { /* ignore */ }
    await server.close();
  });

  describe("GET /api/loop/status", () => {
    it("returns current state and metrics", async () => {
      const res = await fetch(port, "GET", "/api/loop/status");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.state).toBe(LoopState.STOPPED);
      expect(body.metrics).toBeDefined();
      expect(body.metrics.totalCycles).toBe(0);
    });
  });

  describe("GET /api/loop/metrics", () => {
    it("returns metrics JSON", async () => {
      const res = await fetch(port, "GET", "/api/loop/metrics");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.totalCycles).toBe(0);
      expect(body.successfulCycles).toBe(0);
    });
  });

  describe("POST /api/loop/start", () => {
    it("starts the orchestrator", async () => {
      const res = await fetch(port, "POST", "/api/loop/start");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.state).toBe(LoopState.RUNNING);
    });

    it("returns 409 when already running", async () => {
      orchestrator.start();
      const res = await fetch(port, "POST", "/api/loop/start");

      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/loop/pause", () => {
    it("pauses the orchestrator", async () => {
      orchestrator.start();
      const res = await fetch(port, "POST", "/api/loop/pause");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.state).toBe(LoopState.PAUSED);
    });

    it("returns 409 when not running", async () => {
      const res = await fetch(port, "POST", "/api/loop/pause");

      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/loop/stop", () => {
    it("stops the orchestrator", async () => {
      orchestrator.start();
      const res = await fetch(port, "POST", "/api/loop/stop");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.state).toBe(LoopState.STOPPED);
    });
  });

  describe("GET /api/substrate/:fileType", () => {
    it("returns substrate file content and meta", async () => {
      await harness.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Goals\n\n- [ ] Task 1");
      const res = await fetch(port, "GET", "/api/substrate/PLAN");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.rawMarkdown).toBe("# Plan\n\n## Goals\n\n- [ ] Task 1");
      expect(body.meta.fileType).toBe("PLAN");
    });

    it("returns 400 for invalid file type", async () => {
      const res = await fetch(port, "GET", "/api/substrate/INVALID");

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("Invalid file type");
    });

    it("returns 404 when substrate file does not exist", async () => {
      const res = await fetch(port, "GET", "/api/substrate/MEMORY");

      expect(res.status).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("not found");
    });
  });

  describe("POST /api/conversation/send", () => {
    it("appends message to conversation and returns success", async () => {
      await harness.fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n");
      const res = await fetch(port, "POST", "/api/conversation/send", JSON.stringify({ message: "Hello world" }));

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });

    it("returns 400 when message is missing", async () => {
      const res = await fetch(port, "POST", "/api/conversation/send", JSON.stringify({}));

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toContain("message");
    });

    it("returns 400 when body is not valid JSON", async () => {
      const res = await fetch(port, "POST", "/api/conversation/send", "not json");

      expect(res.status).toBe(400);
      const body = JSON.parse(res.body);
      expect(body.error).toBeDefined();
    });

    it("emits conversation_message event when eventSink is configured", async () => {
      await harness.fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n");
      server.setEventSink(harness.eventSink, harness.clock);
      harness.eventSink.reset();

      const res = await fetch(port, "POST", "/api/conversation/send", JSON.stringify({ message: "Hi there" }));

      expect(res.status).toBe(200);
      const events = harness.eventSink.getEvents();
      const msgEvent = events.find(e => e.type === "conversation_message");
      expect(msgEvent).toBeDefined();
      expect(msgEvent!.data.role).toBe("USER");
      expect(msgEvent!.data.message).toBe("Hi there");
    });

    it("calls orchestrator.nudge() to wake the loop", async () => {
      await harness.fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n");
      const nudgeSpy = jest.spyOn(orchestrator, "nudge");

      const res = await fetch(port, "POST", "/api/conversation/send", JSON.stringify({ message: "Wake up" }));

      expect(res.status).toBe(200);
      expect(nudgeSpy).toHaveBeenCalledTimes(1);
    });
  });

  describe("POST /api/loop/resume", () => {
    it("resumes a paused orchestrator", async () => {
      orchestrator.start();
      orchestrator.pause();
      const res = await fetch(port, "POST", "/api/loop/resume");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.state).toBe(LoopState.RUNNING);
    });

    it("returns 409 when not paused", async () => {
      const res = await fetch(port, "POST", "/api/loop/resume");

      expect(res.status).toBe(409);
    });
  });

  describe("POST /api/loop/audit", () => {
    it("triggers on-demand audit", async () => {
      const res = await fetch(port, "POST", "/api/loop/audit");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.success).toBe(true);
    });
  });

  describe("GET /api/reports/latest", () => {
    it("returns latest report", async () => {
      await harness.fs.mkdir("/substrate/reports", { recursive: true });
      const reportStore = new GovernanceReportStore(harness.fs, "/substrate/reports", harness.clock);
      server.setReportStore(reportStore);

      await reportStore.save({ findings: [], proposalEvaluations: [], summary: "Clean" });

      const res = await fetch(port, "GET", "/api/reports/latest");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.summary).toBe("Clean");
    });

    it("returns 404 when no reports exist", async () => {
      await harness.fs.mkdir("/substrate/reports", { recursive: true });
      const reportStore = new GovernanceReportStore(harness.fs, "/substrate/reports", harness.clock);
      server.setReportStore(reportStore);

      const res = await fetch(port, "GET", "/api/reports/latest");

      expect(res.status).toBe(404);
    });
  });

  describe("GET /api/reports", () => {
    it("lists recent reports", async () => {
      await harness.fs.mkdir("/substrate/reports", { recursive: true });
      const reportStore = new GovernanceReportStore(harness.fs, "/substrate/reports", harness.clock);
      server.setReportStore(reportStore);

      harness.clock.setNow(new Date("2025-06-15T10:00:00.000Z"));
      await reportStore.save({ findings: [], proposalEvaluations: [], summary: "First" });
      harness.clock.setNow(new Date("2025-06-15T11:00:00.000Z"));
      await reportStore.save({ findings: [], proposalEvaluations: [], summary: "Second" });

      const res = await fetch(port, "GET", "/api/reports");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body).toHaveLength(2);
      expect(body[0].summary).toBe("Second");
    });
  });

  describe("GET /api/health", () => {
    it("returns health check result", async () => {
      // Write minimal valid substrate files
      await harness.fs.mkdir("/substrate", { recursive: true });
      await harness.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild authentication\n\n## Tasks\n- [ ] Task A\n- [ ] Task B");
      await harness.fs.writeFile("/substrate/VALUES.md", "# Values\n\nGood values");
      await harness.fs.writeFile("/substrate/SECURITY.md", "# Security\n\n## Constraints\nSafe");
      await harness.fs.writeFile("/substrate/CHARTER.md", "# Charter\n\nMission");
      await harness.fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nBuilding authentication system");
      await harness.fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nKnown: authentication, TypeScript");

      const healthCheck = new HealthCheck(harness.reader);
      server.setHealthCheck(healthCheck);

      const res = await fetch(port, "GET", "/api/health");

      expect(res.status).toBe(200);
      const body = JSON.parse(res.body);
      expect(body.overall).toBeDefined();
      expect(body.drift).toBeDefined();
      expect(body.security).toBeDefined();
    });

    it("returns 500 when health check not configured", async () => {
      const res = await fetch(port, "GET", "/api/health");

      expect(res.status).toBe(500);
    });
  });

  describe("unknown routes", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await fetch(port, "GET", "/api/unknown");

      expect(res.status).toBe(404);
    });

    it("returns 404 for wrong method", async () => {
      const res = await fetch(port, "DELETE", "/api/loop/status");

      expect(res.status).toBe(404);
    });
  });
});
