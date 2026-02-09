import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { ImmediateTimer } from "../../src/loop/ImmediateTimer";
import { defaultLoopConfig } from "../../src/loop/types";
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
import { asStreamJson } from "../helpers/streamJson";

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

  return { fs, clock, runner, appendWriter, ego, subconscious, superego, id };
}

async function setupSubstrate(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nDone\n\n## Tasks\n- [x] Done");
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

describe("Integration: Superego Audit", () => {
  it("triggers periodic audit at configured interval", async () => {
    const deps = createDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ superegoAuditInterval: 2, maxConsecutiveIdleCycles: 3 });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config
    );

    // Cycle 2 will trigger audit — superego.audit() needs a Claude response
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        findings: [{ severity: "info", message: "All is well" }],
        proposalEvaluations: [],
        summary: "System healthy",
      })),
      stderr: "",
      exitCode: 0,
    });

    orchestrator.start();
    await orchestrator.runLoop();

    // Should have 1 audit (at cycle 2)
    expect(orchestrator.getMetrics().superegoAudits).toBe(1);

    // Verify audit_complete event emitted
    const events = eventSink.getEvents();
    const auditEvents = events.filter((e) => e.type === "audit_complete");
    expect(auditEvents.length).toBe(1);
  });

  it("triggers on-demand audit via requestAudit()", async () => {
    const deps = createDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ superegoAuditInterval: 100 }); // high interval
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config
    );

    // Prepare audit response
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        findings: [],
        proposalEvaluations: [],
        summary: "On-demand audit clean",
      })),
      stderr: "",
      exitCode: 0,
    });

    orchestrator.start();
    orchestrator.requestAudit();

    // Run one cycle — audit should trigger because of requestAudit
    await orchestrator.runOneCycle();

    expect(orchestrator.getMetrics().superegoAudits).toBe(1);

    // Verify evaluation_requested event was emitted before the audit
    const events = eventSink.getEvents();
    const evalEvent = events.find((e) => e.type === "evaluation_requested");
    expect(evalEvent).toBeDefined();
  });

  it("logs audit to progress", async () => {
    const deps = createDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ superegoAuditInterval: 1 });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config
    );

    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        findings: [],
        proposalEvaluations: [],
        summary: "Audit complete: system in good shape",
      })),
      stderr: "",
      exitCode: 0,
    });

    orchestrator.start();
    await orchestrator.runOneCycle();

    const progress = await deps.fs.readFile("/substrate/PROGRESS.md");
    expect(progress).toContain("Audit complete: system in good shape");
  });
});
