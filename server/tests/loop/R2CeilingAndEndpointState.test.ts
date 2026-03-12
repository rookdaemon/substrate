import * as realFs from "fs";
import * as os from "os";
import * as path from "path";
import { IFileSystem } from "../../src/substrate/abstractions/IFileSystem";
import { NodeFileSystem } from "../../src/substrate/abstractions/NodeFileSystem";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { ImmediateTimer } from "../../src/loop/ImmediateTimer";
import { defaultLoopConfig, LoopState } from "../../src/loop/types";
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
import { TaskClassifier } from "../../src/agents/TaskClassifier";
import { ConversationManager } from "../../src/conversation/ConversationManager";
import { IConversationCompactor } from "../../src/conversation/IConversationCompactor";

class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

function createDeps() {
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
  const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
  const compactor = new MockCompactor();
  const conversationManager = new ConversationManager(
    reader, fs, config, lock, appendWriter, checker, compactor, clock
  );

  const ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
  const subconscious = new Subconscious(reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, writer);
  const id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier);

  return { fs, clock, launcher, appendWriter, ego, subconscious, superego, id };
}

async function setupIdleSubstrate(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nDone\n\n## Tasks\n- [x] Task A");
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

function createOrchestrator(substratePath?: string, fileSystem?: IFileSystem) {
  const deps = createDeps();
  const logger = new InMemoryLogger();
  const eventSink = new InMemoryEventSink();
  const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 100 });
  const orchestrator = new LoopOrchestrator(
    deps.ego, deps.subconscious, deps.superego, deps.id,
    deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
    config, logger,
    undefined, undefined, undefined, undefined, undefined,
    substratePath,
    fileSystem,
  );
  return { orchestrator, logger, eventSink, deps };
}

describe("R2 pre-dispatch ceiling check", () => {
  it("halts and returns idle when successfulCycles >= 50", async () => {
    const { orchestrator, logger, deps } = createOrchestrator();
    await setupIdleSubstrate(deps.fs);
    // Force metrics to 50 successful cycles
    (orchestrator as unknown as { metrics: { successfulCycles: number } }).metrics.successfulCycles = 50;

    orchestrator.start();
    // executeOneCycle is called by runLoop; call once directly via runLoop with immediate stop
    const runPromise = orchestrator.runLoop();
    await runPromise;

    expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    const warnings = logger.getWarnEntries().filter(e => e.includes("[R2]") && e.includes("ceiling reached"));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("warns but does not halt when successfulCycles >= 30 and < 50", async () => {
    const { orchestrator, logger, deps } = createOrchestrator();
    await setupIdleSubstrate(deps.fs);
    (orchestrator as unknown as { metrics: { successfulCycles: number } }).metrics.successfulCycles = 30;

    orchestrator.start();
    const runPromise = orchestrator.runLoop();
    // Stop after one cycle
    orchestrator.stop();
    await runPromise;

    const warnings = logger.getWarnEntries().filter(e => e.includes("[R2]") && e.includes("dispatch warning"));
    expect(warnings.length).toBeGreaterThanOrEqual(1);
  });

  it("takes no R2 action when successfulCycles < 30", async () => {
    const { orchestrator, logger, deps } = createOrchestrator();
    await setupIdleSubstrate(deps.fs);
    (orchestrator as unknown as { metrics: { successfulCycles: number } }).metrics.successfulCycles = 10;

    orchestrator.start();
    orchestrator.stop();
    const runPromise = orchestrator.runLoop();
    await runPromise;

    const r2Entries = logger.getWarnEntries().filter(e => e.includes("[R2]"));
    expect(r2Entries).toHaveLength(0);
  });
});

describe("readEndpointState() private helper", () => {
  let tempDir: string;

  beforeEach(() => {
    tempDir = realFs.mkdtempSync(path.join(os.tmpdir(), "substrate-ep-test-"));
  });

  afterEach(() => {
    realFs.rmSync(tempDir, { recursive: true, force: true });
  });

  async function callReadEndpointState(substratePath: string): Promise<string> {
    const nodeFs = new NodeFileSystem();
    const { orchestrator } = createOrchestrator(substratePath, nodeFs);
    return (orchestrator as unknown as { readEndpointState(): Promise<string> }).readEndpointState();
  }

  it("T4: returns UNKNOWN string when state file is missing (ENOENT)", async () => {
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("UNKNOWN");
  });

  it("T5: returns UNKNOWN string when state file contains malformed JSON", async () => {
    realFs.writeFileSync(path.join(tempDir, ".endpoint_state.json"), "{ not valid json {{");
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("UNKNOWN");
  });

  it("T1: UP state → contains 'Status: UP' and 'Ollama-gated tasks: GO'", async () => {
    const state = { status: "up", lastChecked: "2026-01-01T00:00:00.000Z", consecutiveDown: 0 };
    realFs.writeFileSync(path.join(tempDir, ".endpoint_state.json"), JSON.stringify(state));
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("Status: UP");
    expect(result).toContain("Ollama-gated tasks: GO");
  });

  it("T2: DOWN state → contains 'Status: DOWN' and 'Skip ALL Ollama-gated tasks'", async () => {
    const state = { status: "down", lastChecked: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", consecutiveDown: 3 };
    realFs.writeFileSync(path.join(tempDir, ".endpoint_state.json"), JSON.stringify(state));
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("Status: DOWN");
    expect(result).toContain("Skip ALL Ollama-gated tasks");
  });

  it("T3: DEGRADED state → contains 'Status: DEGRADED' and 'Skip inference-gated tasks'", async () => {
    const state = { status: "degraded", lastChecked: "2026-01-01T00:00:00.000Z", lastSeen: "2026-01-01T00:00:00.000Z", consecutiveDegraded: 2 };
    realFs.writeFileSync(path.join(tempDir, ".endpoint_state.json"), JSON.stringify(state));
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("Status: DEGRADED");
    expect(result).toContain("Skip inference-gated tasks");
  });

  it("'unknown' status → returns UNKNOWN string", async () => {
    const state = { status: "unknown", lastChecked: "2026-01-01T00:00:00.000Z" };
    realFs.writeFileSync(path.join(tempDir, ".endpoint_state.json"), JSON.stringify(state));
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("UNKNOWN");
  });

  it("T6: stale state (>2h old) → returns UNKNOWN with staleness message regardless of status", async () => {
    // Fixed clock is 2025-06-15T10:00:00Z; 3h before = 2025-06-15T07:00:00Z
    const staleTs = "2025-06-15T07:00:00.000Z";
    const state = { status: "up", checkedAt: staleTs, consecutiveDown: 0 };
    realFs.writeFileSync(path.join(tempDir, ".endpoint_state.json"), JSON.stringify(state));
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("UNKNOWN");
    expect(result).toContain("stale");
  });

  it("T7: checkedAt field (external monitoring format) within 2h → parses as UP correctly", async () => {
    // Fixed clock is 2025-06-15T10:00:00Z; 30min before = 2025-06-15T09:30:00Z
    const recentTs = "2025-06-15T09:30:00.000Z";
    const state = { status: "up", checkedAt: recentTs, consecutiveDown: 0 };
    realFs.writeFileSync(path.join(tempDir, ".endpoint_state.json"), JSON.stringify(state));
    const result = await callReadEndpointState(tempDir);
    expect(result).toContain("Status: UP");
    expect(result).toContain("Ollama-gated tasks: GO");
  });
});
