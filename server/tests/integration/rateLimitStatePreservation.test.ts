import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { RateLimitStateManager } from "../../src/loop/RateLimitStateManager";
import { parseRateLimitReset } from "../../src/loop/rateLimitParser";
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
import { SubstrateFileType } from "../../src/substrate/types";

class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

function createFullDeps() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2026-02-15T10:00:00.000Z"));
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
  
  const rateLimitStateManager = new RateLimitStateManager(
    fs, config, lock, clock, appendWriter, writer, reader
  );

  return { fs, clock, launcher, appendWriter, ego, subconscious, superego, id, reader, config, rateLimitStateManager };
}

async function setupSubstrate(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild the system\n\n## Tasks\n- [ ] Task A\n- [ ] Task B");
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

describe("Integration: Rate Limit State Preservation", () => {
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

  it("saves state before sleeping when rate limit is hit", async () => {
    const deps = createFullDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    orchestrator.setRateLimitStateManager(deps.rateLimitStateManager);

    // Subconscious hits rate limit while executing task-1
    // The rate limit message comes through as an error
    deps.launcher.enqueueFailure("You've hit your limit · resets 12pm (UTC)");

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    // Verify the cycle failed due to rate limit
    expect(result.action).toBe("dispatch");
    expect(result.taskId).toBe("task-1"); // PlanParser generates task-1, task-2, etc.
    expect(result.success).toBe(false);
    expect(result.summary).toContain("resets 12pm");

    // Manually trigger state save (simulating what runLoop does)
    const rateLimitReset = parseRateLimitReset(result.summary, deps.clock.now());
    expect(rateLimitReset).not.toBeNull();
    
    if (rateLimitReset) {
      await deps.rateLimitStateManager.saveStateBeforeSleep(
        rateLimitReset,
        result.action === "dispatch" ? result.taskId : undefined
      );
    }

    // Verify restart-context.md was created
    const restartContextPath = deps.config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
    const restartContent = await deps.fs.readFile(restartContextPath);
    expect(restartContent).toContain("# Restart Context");
    expect(restartContent).toContain("Task ID: task-1");
    expect(restartContent).toContain("Hibernation Start**: 2026-02-15T10:00:00.000Z");

    // Verify PLAN.md was updated with hibernation context
    const planPath = deps.config.getFilePath(SubstrateFileType.PLAN);
    const planContent = await deps.fs.readFile(planPath);
    expect(planContent).toContain("[RATE LIMITED - resuming at 2026-02-15T12:00:00.000Z]");
    expect(planContent).toContain('Task "task-1" was interrupted');

    // Verify PROGRESS.md has the hibernation entry
    const progressPath = deps.config.getFilePath(SubstrateFileType.PROGRESS);
    const progressContent = await deps.fs.readFile(progressPath);
    expect(progressContent).toContain("[2026-02-15T10:00:00.000Z] [SYSTEM] Rate limit hibernation starting");
    expect(progressContent).toContain("Reset expected at 2026-02-15T12:00:00.000Z");
  });

  it("does not save state when no rate limit occurs during idle cycle", async () => {
    const deps = createFullDeps();
    await setupSubstrate(deps.fs);
    
    // Update PLAN.md to have no tasks (all complete)
    await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild the system\n\n## Tasks\n- [x] Task A (completed)\n- [x] Task B (completed)");

    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    orchestrator.setRateLimitStateManager(deps.rateLimitStateManager);

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    // Verify idle cycle (no tasks to dispatch)
    expect(result.action).toBe("idle");

    // Verify restart-context.md was NOT created (no rate limit hit)
    const restartContextPath = deps.config.getFilePath(SubstrateFileType.RESTART_CONTEXT);
    const exists = await deps.fs.stat(restartContextPath).then(() => true).catch(() => false);
    expect(exists).toBe(false);
  });

  it("processes rate limit with specific date correctly", async () => {
    const deps = createFullDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    orchestrator.setRateLimitStateManager(deps.rateLimitStateManager);

    // Subconscious hits rate limit with specific date
    deps.launcher.enqueueFailure("You've hit your limit · resets Feb 16, 3pm (UTC)");

    orchestrator.start();
    const result = await orchestrator.runOneCycle();

    // Manually trigger state save (simulating what runLoop does)
    const rateLimitReset = parseRateLimitReset(result.summary, deps.clock.now());
    expect(rateLimitReset).not.toBeNull();
    
    if (rateLimitReset) {
      await deps.rateLimitStateManager.saveStateBeforeSleep(
        rateLimitReset,
        result.action === "dispatch" ? result.taskId : undefined
      );
    }

    // Verify the state was saved with correct reset time
    const progressPath = deps.config.getFilePath(SubstrateFileType.PROGRESS);
    const progressContent = await deps.fs.readFile(progressPath);
    expect(progressContent).toContain("Reset expected at 2026-02-16T15:00:00.000Z");
    
    // Verify PLAN.md has correct reset time
    const planPath = deps.config.getFilePath(SubstrateFileType.PLAN);
    const planContent = await deps.fs.readFile(planPath);
    expect(planContent).toContain("[RATE LIMITED - resuming at 2026-02-16T15:00:00.000Z]");
  });
});

describe("Rate limit backoff is not bypassed by timer.wake()", () => {
  let orchestrator: LoopOrchestrator | null = null;

  afterEach(() => {
    if (orchestrator) {
      try { orchestrator.stop(); } catch { /* ignore */ }
      orchestrator = null;
    }
  });

  it("re-sleeps when rate limited and timer is woken early", async () => {
    const deps = createFullDeps();
    await setupSubstrate(deps.fs);

    // Cycle 1: task hits rate limit
    deps.launcher.enqueueFailure("You've hit your limit · resets 12pm (UTC)");

    // Responses for cycle after rate limit clears
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success", summary: "Done", progressEntry: "Completed",
      skillUpdates: null, memoryUpdates: null, proposals: [],
    }));
    deps.launcher.enqueueSuccess(JSON.stringify({
      outcomeMatchesIntent: true, qualityScore: 90,
      issuesFound: [], recommendedActions: [], needsReassessment: false,
    }));

    const delayLog: number[] = [];
    let cycleCount = 0;

    // Timer that simulates early wake on first rate-limit delay,
    // then stops orchestrator after enough cycles to prevent infinite loop
    const timer = {
      delay: async (ms: number) => {
        delayLog.push(ms);
        // Rate-limit delays are large (>60s); inter-cycle delays are small
        if (ms > 60000) {
          // First rate-limit delay: advance only 30s (simulate watchdog wake)
          if (delayLog.filter(d => d > 60000).length === 1) {
            deps.clock.advance(30_000);
            return;
          }
          // Subsequent rate-limit delays: advance past the rate limit
          deps.clock.advance(ms);
          return;
        }
        // Inter-cycle delay: advance clock, stop after a few cycles
        deps.clock.advance(ms);
        cycleCount++;
        if (cycleCount > 3) {
          orchestrator!.stop();
        }
      },
      wake: () => {},
    };

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 3 });
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, new InMemoryLogger()
    );

    orchestrator.start();
    await orchestrator.runLoop();

    // The rate limit backoff should produce TWO large delays:
    // 1. Initial backoff (woken early after 30s)
    // 2. Re-sleep for remaining time
    const rateLimitDelays = delayLog.filter(d => d > 60000);
    expect(rateLimitDelays.length).toBeGreaterThanOrEqual(2);

    // Second delay should be less than the first (remaining time after 30s advance)
    expect(rateLimitDelays[1]).toBeLessThan(rateLimitDelays[0]);
  });
});

describe("LoopOrchestrator: setRateLimitUntil (disk restore)", () => {
  let orchestrator: LoopOrchestrator | null = null;

  afterEach(() => {
    if (orchestrator) {
      try { orchestrator.stop(); } catch { /* ignore */ }
      orchestrator = null;
    }
  });

  it("setRateLimitUntil sets the persisted rate-limit timestamp", () => {
    const deps = createFullDeps();
    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    expect(orchestrator.getRateLimitUntil()).toBeNull();

    const future = "2099-01-01T00:00:00.000Z";
    orchestrator.setRateLimitUntil(future);
    expect(orchestrator.getRateLimitUntil()).toBe(future);
  });

  it("setRateLimitUntil(null) clears the rate-limit marker", () => {
    const deps = createFullDeps();
    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    orchestrator.setRateLimitUntil("2099-01-01T00:00:00.000Z");
    orchestrator.setRateLimitUntil(null);
    expect(orchestrator.getRateLimitUntil()).toBeNull();
  });

  it("isEffectivelyPaused returns true while setRateLimitUntil is non-null", () => {
    const deps = createFullDeps();
    const eventSink = new InMemoryEventSink();
    orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      defaultLoopConfig(), new InMemoryLogger()
    );

    expect(orchestrator.isEffectivelyPaused()).toBe(false);
    orchestrator.setRateLimitUntil("2099-01-01T00:00:00.000Z");
    expect(orchestrator.isEffectivelyPaused()).toBe(true);
    orchestrator.setRateLimitUntil(null);
    expect(orchestrator.isEffectivelyPaused()).toBe(false);
  });
});
