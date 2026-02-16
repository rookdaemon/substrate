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
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] task-1 Implement feature X\n- [ ] task-2 Write tests");
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

describe("Reconsideration Loop Integration", () => {
  let deps: ReturnType<typeof createFullDeps>;
  let orchestrator: LoopOrchestrator;
  let eventSink: InMemoryEventSink;
  

  beforeEach(async () => {
    deps = createFullDeps();
    
    eventSink = new InMemoryEventSink();
    

    await setupSubstrate(deps.fs);

    const timer = new ImmediateTimer();
    const logger = new InMemoryLogger();
    const config = defaultLoopConfig();

    orchestrator = new LoopOrchestrator(
      deps.ego,
      deps.subconscious,
      deps.superego,
      deps.id,
      deps.appendWriter,
      deps.clock,
      timer,
      eventSink,
      config,
      logger
    );
  });

  it("runs reconsideration after successful task execution", async () => {
    // Task execution response
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Feature implemented successfully",
      progressEntry: "Implemented feature X with all components",
      skillUpdates: null,
      memoryUpdates: null,
      proposals: [],
    }));

    // Reconsideration evaluation response
    deps.launcher.enqueueSuccess(JSON.stringify({
      outcomeMatchesIntent: true,
      qualityScore: 90,
      issuesFound: [],
      recommendedActions: ["Add performance tests"],
      needsReassessment: false,
    }));

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    expect(result.success).toBe(true);
    expect(result.taskId).toBe("task-1");

    // Check that reconsideration event was emitted
    const reconsiderationEvents = eventSink.getEvents().filter(e => e.type === "reconsideration_complete");
    expect(reconsiderationEvents).toHaveLength(1);
    expect(reconsiderationEvents[0].data.taskId).toBe("task-1");
    expect(reconsiderationEvents[0].data.outcomeMatchesIntent).toBe(true);
    expect(reconsiderationEvents[0].data.qualityScore).toBe(90);
    expect(reconsiderationEvents[0].data.needsReassessment).toBe(false);
  });

  it("runs reconsideration after partial task execution", async () => {
    // Task execution response (partial)
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "partial",
      summary: "Feature partially implemented",
      progressEntry: "Core logic done, tests pending",
      skillUpdates: null,
      memoryUpdates: null,
      proposals: [],
    }));

    // Reconsideration evaluation response
    deps.launcher.enqueueSuccess(JSON.stringify({
      outcomeMatchesIntent: false,
      qualityScore: 60,
      issuesFound: ["Tests not implemented", "Documentation missing"],
      recommendedActions: ["Write tests", "Add docs"],
      needsReassessment: true,
    }));

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    expect(result.success).toBe(false); // Partial is treated as not success

    const reconsiderationEvents = eventSink.getEvents().filter(e => e.type === "reconsideration_complete");
    expect(reconsiderationEvents).toHaveLength(1);
    expect(reconsiderationEvents[0].data.outcomeMatchesIntent).toBe(false);
    expect(reconsiderationEvents[0].data.qualityScore).toBe(60);
    expect(reconsiderationEvents[0].data.needsReassessment).toBe(true);
    expect(reconsiderationEvents[0].data.issuesCount).toBe(2);
  });

  it("does not run reconsideration after failed task execution", async () => {
    // Task execution response (failure)
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "failure",
      summary: "Task failed due to missing dependencies",
      progressEntry: "Could not complete task",
      skillUpdates: null,
      memoryUpdates: null,
      proposals: [],
    }));

    // No reconsideration response needed - should not be called

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    expect(result.success).toBe(false);

    // Reconsideration should NOT run for failed tasks
    const reconsiderationEvents = eventSink.getEvents().filter(e => e.type === "reconsideration_complete");
    expect(reconsiderationEvents).toHaveLength(0);
  });

  it("does not pollute PROGRESS.md with raw reconsideration logs", async () => {
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Feature implemented",
      progressEntry: "Done",
      skillUpdates: null,
      memoryUpdates: null,
      proposals: [],
    }));

    deps.launcher.enqueueSuccess(JSON.stringify({
      outcomeMatchesIntent: true,
      qualityScore: 85,
      issuesFound: ["Minor performance issue"],
      recommendedActions: ["Optimize query"],
      needsReassessment: false,
    }));

    orchestrator.start();
    await orchestrator.runOneCycle();

    const progress = await deps.fs.readFile("/substrate/PROGRESS.md");
    // PROGRESS.md should NOT contain raw reconsideration logs
    expect(progress).not.toContain("Reconsideration for task task-1");
    expect(progress).not.toContain("Outcome matches intent");
    expect(progress).not.toContain("Quality score: 85/100");
    expect(progress).not.toContain("Issues found: Minor performance issue");
    expect(progress).not.toContain("Recommended actions: Optimize query");
    expect(progress).not.toContain("Needs reassessment");
  });

  it("handles reconsideration evaluation errors gracefully", async () => {
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Feature implemented",
      progressEntry: "Done",
      skillUpdates: null,
      memoryUpdates: null,
      proposals: [],
    }));

    // Reconsideration fails
    deps.launcher.enqueueFailure("Claude timeout");

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    // Task should still be marked as successful
    expect(result.success).toBe(true);

    // Reconsideration event should indicate conservative defaults
    const reconsiderationEvents = eventSink.getEvents().filter(e => e.type === "reconsideration_complete");
    expect(reconsiderationEvents).toHaveLength(1);
    expect(reconsiderationEvents[0].data.outcomeMatchesIntent).toBe(false);
    expect(reconsiderationEvents[0].data.qualityScore).toBe(0);
    expect(reconsiderationEvents[0].data.needsReassessment).toBe(true);
  });

  it("does not run reconsideration for idle cycles", async () => {
    // Update plan to have no pending tasks
    await deps.fs.writeFile(
      "/substrate/PLAN.md",
      "# Plan\n\n## Current Goal\nBuild feature\n\n## Tasks\n- [x] task-1 Done"
    );

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    expect(result.action).toBe("idle");

    // No reconsideration for idle cycles
    const reconsiderationEvents = eventSink.getEvents().filter(e => e.type === "reconsideration_complete");
    expect(reconsiderationEvents).toHaveLength(0);
  });

  it("still logs structured progressEntry content to PROGRESS.md", async () => {
    const structuredEntry = "## 2025-06-15 - Implement Feature X (COMPLETE)\n\n**Summary:** Feature X implemented successfully with all components.";
    
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Feature implemented",
      progressEntry: structuredEntry,
      skillUpdates: null,
      memoryUpdates: null,
      proposals: [],
    }));

    deps.launcher.enqueueSuccess(JSON.stringify({
      outcomeMatchesIntent: true,
      qualityScore: 90,
      issuesFound: [],
      recommendedActions: [],
      needsReassessment: false,
    }));

    orchestrator.start();
    await orchestrator.runOneCycle();

    const progress = await deps.fs.readFile("/substrate/PROGRESS.md");
    // PROGRESS.md SHOULD contain structured progressEntry content
    expect(progress).toContain(structuredEntry);
    expect(progress).toContain("Feature X implemented successfully");
  });
});
