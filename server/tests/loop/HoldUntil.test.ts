/**
 * Unit tests for HOLD_UNTIL enforcement in LoopOrchestrator.
 *
 * Acceptance criteria (from issue):
 *  - Task with HOLD_UNTIL: <future ISO8601Z> is not dispatched (no API call)
 *  - Task with HOLD_UNTIL: <past ISO8601Z> is dispatched normally
 *  - Task with no HOLD_UNTIL marker is dispatched normally
 *  - Debug log emitted when task is held (task ID + timestamp)
 *  - Backward compatible — no schema changes to PLAN.md format
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

class MockTimer implements ITimer {
  async delay(_ms: number): Promise<void> {}
  wake(): void {}
}

class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

// Base time: 2026-03-12T08:00:00Z
const BASE_TIME = new Date("2026-03-12T08:00:00.000Z");
const FUTURE_HOLD = "2026-03-12T09:00:00Z";   // 1 hour in the future
const PAST_HOLD   = "2026-03-11T09:00:00Z";   // 1 day in the past

function createDeps() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(BASE_TIME);
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

async function setupSubstrateWithTask(fs: InMemoryFileSystem, taskTitle: string) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", `# Plan\n\n## Current Goal\nTest\n\n## Tasks\n- [ ] ${taskTitle}`);
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

function successResult() {
  return JSON.stringify({
    result: "success",
    summary: "Done",
    progressEntry: "Completed",
    skillUpdates: null,
    memoryUpdates: null,
    proposals: [],
    agoraReplies: [],
  });
}

describe("LoopOrchestrator: HOLD_UNTIL enforcement", () => {
  it("does not dispatch when HOLD_UNTIL is in the future", async () => {
    const deps = createDeps();
    await setupSubstrateWithTask(deps.fs, `Calibrate Groq Id HOLD_UNTIL: ${FUTURE_HOLD}`);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: false });
    const timer = new MockTimer();

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    // No launcher responses queued — the LLM must not be called
    orchestrator.start();
    await orchestrator.runLoop();

    const launches = deps.launcher.getLaunches();
    const subconsciousExecuteCalls = launches.filter(l =>
      l.request.message?.includes("Execute this task:") ?? false
    );
    expect(subconsciousExecuteCalls).toHaveLength(0);
  });

  it("emits [HOLD_UNTIL] debug log with task ID and timestamp when task is held", async () => {
    const deps = createDeps();
    await setupSubstrateWithTask(deps.fs, `Calibrate Groq Id HOLD_UNTIL: ${FUTURE_HOLD}`);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: false });
    const timer = new MockTimer();

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    orchestrator.start();
    await orchestrator.runLoop();

    const logEntries = logger.getEntries();
    const holdEntry = logEntries.find(e => e.includes("[HOLD_UNTIL]"));
    expect(holdEntry).toBeDefined();
    expect(holdEntry).toContain("task-1");
    expect(holdEntry).toContain(new Date(FUTURE_HOLD).toISOString());
  });

  it("dispatches normally when HOLD_UNTIL is in the past", async () => {
    const deps = createDeps();
    await setupSubstrateWithTask(deps.fs, `Old task HOLD_UNTIL: ${PAST_HOLD}`);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });
    const timer = new MockTimer();

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    const launches = deps.launcher.getLaunches();
    const subconsciousExecuteCalls = launches.filter(l =>
      l.request.message?.includes("Execute this task:") ?? false
    );
    expect(subconsciousExecuteCalls).toHaveLength(1);

    // No [HOLD_UNTIL] log emitted for past timestamp
    const logEntries = logger.getEntries();
    expect(logEntries.find(e => e.includes("[HOLD_UNTIL]"))).toBeUndefined();
  });

  it("dispatches normally when no HOLD_UNTIL marker is present", async () => {
    const deps = createDeps();
    await setupSubstrateWithTask(deps.fs, "Regular task with no hold marker");

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });
    const timer = new MockTimer();

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    deps.launcher.enqueueSuccess(successResult());

    orchestrator.start();
    await orchestrator.runLoop();

    const launches = deps.launcher.getLaunches();
    const subconsciousExecuteCalls = launches.filter(l =>
      l.request.message?.includes("Execute this task:") ?? false
    );
    expect(subconsciousExecuteCalls).toHaveLength(1);

    // No [HOLD_UNTIL] log emitted
    const logEntries = logger.getEntries();
    expect(logEntries.find(e => e.includes("[HOLD_UNTIL]"))).toBeUndefined();
  });
});
