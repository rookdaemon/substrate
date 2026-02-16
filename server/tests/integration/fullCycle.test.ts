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

function createFullDeps() {
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
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier);
  const id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier);

  return { fs, clock, launcher, appendWriter, ego, subconscious, superego, id, reader };
}

async function setupSubstrate(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] Task A\n- [ ] Task B");
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

describe("Integration: Full Cycle", () => {
  let orchestrator: LoopOrchestrator | null = null;

  afterEach(() => {
    if (orchestrator) {
      try {
        orchestrator.stop();
      } catch {
        // ignore
      }
      orchestrator = null;
    }
  });

  it("dispatches a task, executes it, marks complete, and logs progress", async () => {
    const deps = createFullDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Task A completed",
      progressEntry: "Finished Task A successfully",
      skillUpdates: null,
      proposals: [],
    }));

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    expect(result.action).toBe("dispatch");
    expect(result.success).toBe(true);

    // Verify task marked complete in PLAN
    const plan = await deps.fs.readFile("/substrate/PLAN.md");
    expect(plan).toContain("[x] Task A");

    // Verify progress logged
    const progress = await deps.fs.readFile("/substrate/PROGRESS.md");
    expect(progress).toContain("Finished Task A successfully");
  });

  it("runs full loop: dispatch two tasks then stop on idle", async () => {
    const deps = createFullDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1 });
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, new InMemoryLogger()
    );

    // Task A
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Task A done",
      progressEntry: "Did A",
      skillUpdates: null,
      proposals: [],
    }));

    // Reconsideration after Task A
    deps.launcher.enqueueSuccess(JSON.stringify({
      outcomeMatchesIntent: true,
      qualityScore: 80,
      issuesFound: [],
      recommendedActions: [],
      needsReassessment: false,
    }));

    // Task B
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Task B done",
      progressEntry: "Did B",
      skillUpdates: null,
      proposals: [],
    }));

    // Reconsideration after Task B
    deps.launcher.enqueueSuccess(JSON.stringify({
      outcomeMatchesIntent: true,
      qualityScore: 80,
      issuesFound: [],
      recommendedActions: [],
      needsReassessment: false,
    }));

    orchestrator.start();
    await orchestrator.runLoop();

    const metrics = orchestrator.getMetrics();
    expect(metrics.successfulCycles).toBe(2);
    expect(metrics.totalCycles).toBe(3); // 2 dispatch + 1 idle

    // Both tasks should be marked complete
    const plan = await deps.fs.readFile("/substrate/PLAN.md");
    expect(plan).toContain("[x] Task A");
    expect(plan).toContain("[x] Task B");
  });

  it("handles task failure without crashing the loop", async () => {
    const deps = createFullDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "failure",
      summary: "Task A failed miserably",
      progressEntry: "",
      skillUpdates: null,
      proposals: [],
    }));

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    expect(result.action).toBe("dispatch");
    expect(result.success).toBe(false);
    expect(orchestrator.getMetrics().failedCycles).toBe(1);
  });
});
