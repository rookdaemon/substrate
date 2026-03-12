/**
 * Unit tests for blocked task scheduling in LoopOrchestrator.
 *
 * Acceptance criteria (from issue):
 *  - [BLOCKED] log emitted when a task returns result==="blocked"
 *  - [UNBLOCKED] log emitted when the same task is re-dispatched after retryAfter
 *  - blocked task is NOT re-dispatched before retryAfter elapses
 *  - blocked task IS re-dispatched after retryAfter elapses
 *  - partial task still dispatched every cycle (no regression)
 */

import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { ITimer } from "../../src/loop/ITimer";
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

/** Timer that advances the injected clock by the requested delay amount, so retryAfter
 *  expiration checks behave correctly in tests without spinning in a real timer loop. */
class ClockAdvancingTimer implements ITimer {
  constructor(private readonly clock: FixedClock) {}
  async delay(ms: number): Promise<void> {
    this.clock.advance(ms);
  }
  wake(): void {}
}

class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

function createDeps() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2026-03-12T08:00:00.000Z"));
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

/** Substrate with a single pending task. */
async function setupActiveTaskSubstrate(fs: InMemoryFileSystem, taskId = "Task A") {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", `# Plan\n\n## Current Goal\nTest\n\n## Tasks\n- [ ] ${taskId}`);
  await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\n");
  await fs.writeFile("/substrate/HABITS.md", "# Habits\n\n");
  await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\n");
  await fs.writeFile("/substrate/VALUES.md", "# Values\n\n");
  await fs.writeFile("/substrate/ID.md", "# Id\n\n");
  await fs.writeFile("/substrate/SECURITY.md", "# Security\n\n");
  await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\n");
  await fs.writeFile("/substrate/SUPEREGO.md", "# Superego\n\n");
  await fs.writeFile("/substrate/CLAUDE.md", "# Claude\n\n");
  await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
  await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
}

function blockedResult(retryAfter: string) {
  return JSON.stringify({
    result: "blocked",
    summary: "Rate limited — blocked until " + retryAfter,
    progressEntry: "",
    skillUpdates: null,
    memoryUpdates: null,
    proposals: [],
    agoraReplies: [],
    retryAfter,
  });
}

function successResult() {
  return JSON.stringify({
    result: "success",
    summary: "Done",
    progressEntry: "Completed the task — opened pull request for review",
    skillUpdates: null,
    memoryUpdates: null,
    proposals: [],
    agoraReplies: [],
  });
}

function partialResult() {
  return JSON.stringify({
    result: "partial",
    summary: "In progress",
    progressEntry: "",
    skillUpdates: null,
    memoryUpdates: null,
    proposals: [],
    agoraReplies: [],
  });
}

describe("LoopOrchestrator: blocked task scheduling", () => {
  it("[BLOCKED] log is emitted when a task returns result=blocked", async () => {
    const deps = createDeps();
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    // maxConsecutiveIdleCycles=0 ensures the loop backs off or sleeps immediately after one cycle
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });
    const timer = new ClockAdvancingTimer(deps.clock);

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    // retryAfter is 55 minutes from "now" (08:00Z → 08:55Z)
    const retryAfter = "2026-03-12T08:55:00.000Z";
    deps.launcher.enqueueSuccess(blockedResult(retryAfter));
    // After the retryAfter period elapses, dispatch succeeds
    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    const logEntries = logger.getEntries();
    const blockedEntry = logEntries.find(e => e.includes("[BLOCKED]"));
    expect(blockedEntry).toBeDefined();
    expect(blockedEntry).toContain("task-1");
    expect(blockedEntry).toContain(retryAfter);
  });

  it("[UNBLOCKED] log is emitted when blocked task is re-dispatched after retryAfter", async () => {
    const deps = createDeps();
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });
    const timer = new ClockAdvancingTimer(deps.clock);

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    const retryAfter = "2026-03-12T08:55:00.000Z";
    deps.launcher.enqueueSuccess(blockedResult(retryAfter));
    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    const logEntries = logger.getEntries();
    const unblockedEntry = logEntries.find(e => e.includes("[UNBLOCKED]"));
    expect(unblockedEntry).toBeDefined();
    expect(unblockedEntry).toContain("task-1");
  });

  it("[UNBLOCKED] appears after [BLOCKED] in log entries", async () => {
    const deps = createDeps();
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });
    const timer = new ClockAdvancingTimer(deps.clock);

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    const retryAfter = "2026-03-12T08:55:00.000Z";
    deps.launcher.enqueueSuccess(blockedResult(retryAfter));
    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    const logEntries = logger.getEntries();
    const blockedIdx = logEntries.findIndex(e => e.includes("[BLOCKED]"));
    const unblockedIdx = logEntries.findIndex(e => e.includes("[UNBLOCKED]"));
    expect(blockedIdx).toBeGreaterThanOrEqual(0);
    expect(unblockedIdx).toBeGreaterThanOrEqual(0);
    expect(unblockedIdx).toBeGreaterThan(blockedIdx);
  });

  it("blocked task is not re-dispatched before retryAfter elapses", async () => {
    const deps = createDeps();
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    // Use a timer that advances the clock so retryAfter checks resolve correctly
    const timer = new ClockAdvancingTimer(deps.clock);
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    // Blocked with retryAfter 55 minutes ahead; timer advances clock past that, then success
    const retryAfter = "2026-03-12T08:55:00.000Z";
    deps.launcher.enqueueSuccess(blockedResult(retryAfter));
    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    // Subconscious should have been invoked exactly twice:
    //  1. First call → returns blocked
    //  2. After backoff expires → returns success
    // If the orchestrator re-dispatched during the backoff period it would have launched >2 times.
    const launches = deps.launcher.getLaunches();
    // Launches include all role calls (Ego dispatchNext + Subconscious execute).
    // Count only Subconscious execute calls (not evaluateOutcome from reconsideration)
    // by checking that message contains the task execution preamble.
    const subconscious = launches.filter(l =>
      l.request.message?.includes("Execute this task:") ?? false
    );
    expect(subconscious).toHaveLength(2);
  });

  it("blocked task is re-dispatched after retryAfter elapses (clock advances past it)", async () => {
    const deps = createDeps();
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const timer = new ClockAdvancingTimer(deps.clock);
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    const retryAfter = "2026-03-12T08:10:00.000Z"; // only 10 minutes away
    deps.launcher.enqueueSuccess(blockedResult(retryAfter));
    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    // Clock should have advanced past retryAfter, second dispatch completed successfully
    expect(deps.clock.now().getTime()).toBeGreaterThanOrEqual(new Date(retryAfter).getTime());
    // metrics.successfulCycles incremented by the second dispatch
    expect(orchestrator.getMetrics().successfulCycles).toBe(1);
    expect(orchestrator.getMetrics().blockedCycles).toBe(1);
  });

  it("partial task is dispatched every cycle without backoff (no regression)", async () => {
    const deps = createDeps();
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    // Allow 2 idle cycles so we dispatch partial twice then reach idle
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 2, idleSleepEnabled: false });
    const timer = new ClockAdvancingTimer(deps.clock);

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    // Two partial cycles, then success (marks task complete → idle → stop)
    deps.launcher.enqueueSuccess(partialResult());
    deps.launcher.enqueueSuccess(partialResult());
    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    // Should have no [BLOCKED] or [UNBLOCKED] entries
    const logEntries = logger.getEntries();
    expect(logEntries.find(e => e.includes("[BLOCKED]"))).toBeUndefined();
    expect(logEntries.find(e => e.includes("[UNBLOCKED]"))).toBeUndefined();

    // blockedCycles metric must remain 0
    expect(orchestrator.getMetrics().blockedCycles).toBe(0);
  });

  it("blockedCycles metric increments for each blocked cycle", async () => {
    const deps = createDeps();
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const timer = new ClockAdvancingTimer(deps.clock);
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    // Block once, then succeed
    const retryAfter = "2026-03-12T08:15:00.000Z";
    deps.launcher.enqueueSuccess(blockedResult(retryAfter));
    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    expect(orchestrator.getMetrics().blockedCycles).toBe(1);
    expect(orchestrator.getMetrics().successfulCycles).toBe(1);
    expect(orchestrator.getMetrics().failedCycles).toBe(0);
  });
});
