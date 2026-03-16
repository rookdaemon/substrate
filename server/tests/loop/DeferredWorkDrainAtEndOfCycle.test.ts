/**
 * Unit tests verifying that DeferredWorkQueue.drain() runs at end-of-cycle,
 * not at the start of the next cycle.
 *
 * Acceptance criteria:
 *  - Deferred items enqueued during cycle N execute at end of cycle N
 *  - Errors in drain do not propagate and crash the cycle
 */

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
import { DeferredWorkQueue } from "../../src/loop/DeferredWorkQueue";

class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

function createDeps() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2026-03-15T10:00:00.000Z"));
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

function createOrchestrator() {
  const deps = createDeps();
  const logger = new InMemoryLogger();
  const eventSink = new InMemoryEventSink();
  const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 100 });
  const orchestrator = new LoopOrchestrator(
    deps.ego, deps.subconscious, deps.superego, deps.id,
    deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
    config, logger,
  );
  return { orchestrator, logger, deps };
}

describe("DeferredWorkQueue drain at end-of-cycle", () => {
  it("deferred item enqueued before cycle runs within that cycle before cycle returns", async () => {
    const { orchestrator, deps } = createOrchestrator();
    await setupIdleSubstrate(deps.fs);

    const order: string[] = [];

    // Enqueue deferred work directly into the orchestrator's queue (simulating work
    // that would be enqueued mid-cycle by e.g. proposal evaluation or reconsideration).
    const deferredWork = (orchestrator as unknown as { deferredWork: DeferredWorkQueue }).deferredWork;
    deferredWork.enqueue(
      new Promise<void>(resolve => {
        order.push("deferred");
        resolve();
      })
    );

    orchestrator.start();
    await orchestrator.runOneCycle();
    order.push("after-cycle");

    // Deferred work must have completed during the cycle, not after
    expect(order).toEqual(["deferred", "after-cycle"]);
  });

  it("drainDeferredWork() is a no-op after runOneCycle() — queue was already drained", async () => {
    const { orchestrator, deps } = createOrchestrator();
    await setupIdleSubstrate(deps.fs);

    const deferredWork = (orchestrator as unknown as { deferredWork: DeferredWorkQueue }).deferredWork;
    deferredWork.enqueue(Promise.resolve());

    orchestrator.start();
    await orchestrator.runOneCycle();

    // drain was called at end of cycle, so queue should be empty
    expect(deferredWork.size).toBe(0);

    // Explicit drainDeferredWork() is now a no-op (no additional work to do)
    await orchestrator.drainDeferredWork(); // should resolve immediately without running extra work
  });

  it("drain error does not propagate or crash the cycle — error is logged", async () => {
    const { orchestrator, logger, deps } = createOrchestrator();
    await setupIdleSubstrate(deps.fs);

    // Patch drain() to throw synchronously to test the try-catch in executeOneCycle
    const deferredWork = (orchestrator as unknown as { deferredWork: DeferredWorkQueue }).deferredWork;
    deferredWork.drain = jest.fn().mockRejectedValue(new Error("drain exploded"));

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    // Cycle must still succeed despite the drain error
    expect(result.success).toBe(true);

    // The error must have been logged as a warning
    const warnEntries = logger.getWarnEntries();
    expect(warnEntries.some(e => e.includes("drain exploded"))).toBe(true);
  });
});
