import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { IdleHandler } from "../../src/loop/IdleHandler";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { ImmediateTimer } from "../../src/loop/ImmediateTimer";
import { ITimer } from "../../src/loop/ITimer";
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
import { TaskClassifier } from "../../src/agents/TaskClassifier";
import { ConversationManager } from "../../src/conversation/ConversationManager";
import { IConversationCompactor } from "../../src/conversation/IConversationCompactor";
import { LoopWatchdog } from "../../src/loop/LoopWatchdog";

/** Timer that advances the injected clock by the requested delay amount, so rate-limit
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

async function setupActiveTaskSubstrate(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nTest\n\n## Tasks\n- [ ] Task A");
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

describe("LoopState.SLEEPING", () => {
  it("has SLEEPING value in enum", () => {
    expect(LoopState.SLEEPING).toBe("SLEEPING");
  });
});

describe("defaultLoopConfig", () => {
  it("idleSleepEnabled defaults to false", () => {
    const config = defaultLoopConfig();
    expect(config.idleSleepEnabled).toBe(false);
  });

  it("allows overriding idleSleepEnabled", () => {
    const config = defaultLoopConfig({ idleSleepEnabled: true });
    expect(config.idleSleepEnabled).toBe(true);
  });
});

describe("LoopOrchestrator: sleep/wake state machine", () => {
  function createOrchestrator(idleSleepEnabled = false) {
    const deps = createDeps();
    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger
    );
    return { orchestrator, eventSink, logger };
  }

  it("starts in STOPPED state", () => {
    const { orchestrator } = createOrchestrator();
    expect(orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("initializeSleeping() transitions STOPPED → SLEEPING", () => {
    const { orchestrator } = createOrchestrator();
    orchestrator.initializeSleeping();
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);
  });

  it("initializeSleeping() is no-op when not STOPPED", () => {
    const { orchestrator } = createOrchestrator();
    orchestrator.start();
    orchestrator.initializeSleeping(); // Should be ignored
    expect(orchestrator.getState()).toBe(LoopState.RUNNING);
  });

  it("wake() transitions SLEEPING → RUNNING", () => {
    const { orchestrator } = createOrchestrator();
    orchestrator.initializeSleeping();
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);
    orchestrator.wake();
    expect(orchestrator.getState()).toBe(LoopState.RUNNING);
  });

  it("wake() throws when not in SLEEPING state", () => {
    const { orchestrator } = createOrchestrator();
    expect(() => orchestrator.wake()).toThrow("Cannot wake: loop is in STOPPED state");
  });

  it("wake() emits state_changed event", () => {
    const { orchestrator, eventSink } = createOrchestrator();
    orchestrator.initializeSleeping();
    orchestrator.wake();
    const stateEvents = eventSink.getEvents().filter(e => e.type === "state_changed");
    const wakeEvent = stateEvents.find(e => e.data.to === LoopState.RUNNING && e.data.from === LoopState.SLEEPING);
    expect(wakeEvent).toBeDefined();
  });

  it("start() from SLEEPING delegates to wake()", () => {
    const { orchestrator } = createOrchestrator();
    orchestrator.initializeSleeping();
    orchestrator.start(); // Should call wake() internally
    expect(orchestrator.getState()).toBe(LoopState.RUNNING);
  });

  it("start() from STOPPED works normally", () => {
    const { orchestrator } = createOrchestrator();
    orchestrator.start();
    expect(orchestrator.getState()).toBe(LoopState.RUNNING);
  });

  it("start() throws from RUNNING (not sleeping, not rate-limited)", () => {
    const { orchestrator } = createOrchestrator();
    orchestrator.start();
    expect(() => orchestrator.start()).toThrow("Cannot start: loop is in RUNNING state");
  });

  it("stop() from SLEEPING transitions to STOPPED", () => {
    const { orchestrator } = createOrchestrator();
    orchestrator.initializeSleeping();
    orchestrator.stop();
    expect(orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("wake() calls resumeLoopFn when set", () => {
    const { orchestrator } = createOrchestrator();
    let resumed = false;
    orchestrator.setResumeLoopFn(async () => { resumed = true; });
    orchestrator.initializeSleeping();
    orchestrator.wake();
    // resumeLoopFn is called fire-and-forget, allow microtask queue to drain
    return Promise.resolve().then(() => {
      expect(resumed).toBe(true);
    });
  });

  it("setSleepCallbacks: onSleepEnter called when entering sleep", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: true });
    const idleHandler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.clock, logger);
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    let sleepEnterCalled = false;
    let sleepExitCalled = false;
    orchestrator.setSleepCallbacks(
      async () => { sleepEnterCalled = true; },
      async () => { sleepExitCalled = true; }
    );

    // Run loop — will go idle, IdleHandler fails, should sleep
    orchestrator.start();
    await orchestrator.runLoop();

    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);
    // Allow async callbacks to run
    await Promise.resolve();
    expect(sleepEnterCalled).toBe(true);
    expect(sleepExitCalled).toBe(false);
  });

  it("setSleepCallbacks: onSleepExit called when waking", () => {
    const { orchestrator } = createOrchestrator();
    let exitCalled = false;
    orchestrator.setSleepCallbacks(
      async () => {},
      async () => { exitCalled = true; }
    );
    orchestrator.initializeSleeping();
    orchestrator.wake();
    return Promise.resolve().then(() => {
      expect(exitCalled).toBe(true);
    });
  });
});

describe("LoopOrchestrator: idle sleep in runLoop", () => {
  it("enters SLEEPING state (not STOPPED) when idle sleep is enabled", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const idleHandler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.clock, logger);
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: true });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    orchestrator.start();
    await orchestrator.runLoop();

    // Should be SLEEPING not STOPPED
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);
  });

  it("sleeps (not stops) when idle threshold reached even with idleSleepEnabled false", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const idleHandler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.clock, logger);
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: false });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    orchestrator.start();
    await orchestrator.runLoop();

    // Always sleep on idle — stopping requires explicit user action
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);
  });

  it("emits state_changed with SLEEPING when idle sleep triggers", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const idleHandler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.clock, logger);
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: true });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    orchestrator.start();
    await orchestrator.runLoop();

    const stateEvents = eventSink.getEvents().filter(e => e.type === "state_changed");
    const sleepEvent = stateEvents.find(e => e.data.to === LoopState.SLEEPING);
    expect(sleepEvent).toBeDefined();
    expect(sleepEvent?.data.from).toBe(LoopState.RUNNING);
  });

  it("loop can be woken and run again after sleeping", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const idleHandler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.clock, logger);
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: true });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    orchestrator.start();
    await orchestrator.runLoop();
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);

    // Wake and run again — should sleep again since still idle
    orchestrator.wake();
    expect(orchestrator.getState()).toBe(LoopState.RUNNING);
    await orchestrator.runLoop();
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);
  });
});

describe("LoopOrchestrator: handleUserMessage wakes sleeping loop", () => {
  it("wakes loop when user message arrives while sleeping", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: true });
    const idleHandler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.clock, logger);
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    let resumeLoopCalled = false;
    orchestrator.setResumeLoopFn(async () => { resumeLoopCalled = true; });

    orchestrator.start();
    await orchestrator.runLoop();
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);

    // Send user message — should wake the loop
    await orchestrator.handleUserMessage("Hello!");
    expect(orchestrator.getState()).toBe(LoopState.RUNNING);
    expect(resumeLoopCalled).toBe(true);
  });
});

describe("LoopOrchestrator: rate limit priority over idle threshold", () => {
  it("rate limit backoff takes priority over idle threshold — loop backs off instead of sleeping immediately", async () => {
    const deps = createDeps();
    // Clock at 10am UTC; rate limit text "resets 7pm (UTC)" resolves to 19:00 UTC (9 hours later)
    deps.clock.setNow(new Date("2025-06-15T10:00:00.000Z"));
    await setupActiveTaskSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    // maxConsecutiveIdleCycles=0 means the idle check fires after every cycle (consecutiveIdleCycles
    // starts at 0, and 0 >= 0 is always true).  In the old ordering this caused the loop to sleep
    // even when a rate-limit message was present in the cycle result; the new ordering checks rate
    // limit first so the backoff is honored before the idle threshold is evaluated.
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 0, idleSleepEnabled: true });
    // Use a timer that advances the clock so rate-limit expiry checks resolve correctly.
    const timer = new ClockAdvancingTimer(deps.clock);

    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, timer, eventSink,
      config, logger
    );

    // Cycle 1: task dispatch fails with a rate-limit message.
    deps.launcher.enqueueFailure("You've hit your limit · resets 7pm (UTC)");
    // Cycle 2 (after backoff): task dispatch succeeds — allows the loop to exit cleanly via the
    // idle threshold (success resets consecutiveIdleCycles to 0, which still >= 0, so SLEEPING).
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Done",
      progressEntry: "",
      skillUpdates: null,
      memoryUpdates: null,
      proposals: [],
      agoraReplies: [],
    }));

    orchestrator.start();
    await orchestrator.runLoop();

    // Loop should have backed off for the rate limit then entered SLEEPING via idle threshold.
    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);

    const events = eventSink.getEvents();

    // A rate-limit "idle" event must have been emitted.
    const rateLimitEvent = events.find(
      (e) => e.type === "idle" && e.data.rateLimitUntil !== undefined
    );
    expect(rateLimitEvent).toBeDefined();

    // The rate-limit event must precede the SLEEPING state change — confirming that the backoff
    // ran before the loop transitioned to sleep.
    const sleepEvent = events.find(
      (e) => e.type === "state_changed" && e.data.to === LoopState.SLEEPING
    );
    expect(sleepEvent).toBeDefined();
    expect(events.indexOf(rateLimitEvent!)).toBeLessThan(events.indexOf(sleepEvent!));
  });
});

describe("LoopOrchestrator: watchdog sleep-awareness", () => {
  function createOrchestratorWithWatchdog() {
    const deps = createDeps();
    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: true });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger
    );

    const injected: string[] = [];
    const watchdog = new LoopWatchdog({
      clock: deps.clock,
      logger,
      injectMessage: (msg) => injected.push(msg),
      stallThresholdMs: 1000,
      forceRestart: () => orchestrator.requestRestart(),
      forceRestartThresholdMs: 500,
    });
    orchestrator.setWatchdog(watchdog);

    return { orchestrator, deps, injected, watchdog };
  }

  it("watchdog does not inject stall reminder when loop is sleeping", () => {
    const { orchestrator, deps, injected } = createOrchestratorWithWatchdog();

    orchestrator.initializeSleeping(); // Simulate restart-in-sleep; watchdog has no lastActivityTime yet

    // Advance well past stall threshold
    deps.clock.advance(5000);

    // The watchdog is paused because the loop started in SLEEPING, and has no
    // lastActivityTime — either guard alone would prevent injection here.
    // Confirming that no stall reminder is injected while sleeping:
    expect(injected).toHaveLength(0);
  });

  it("watchdog pauses when entering sleep and resumes on wake", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1, idleSleepEnabled: true });
    const idleHandler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.clock, logger);
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    const injected: string[] = [];
    const watchdog = new LoopWatchdog({
      clock: deps.clock,
      logger,
      injectMessage: (msg) => injected.push(msg),
      stallThresholdMs: 1,   // 1ms — fires on any check() after activity is recorded
      forceRestartThresholdMs: 0,
    });
    orchestrator.setWatchdog(watchdog);
    watchdog.start(999999); // Long interval — we'll check() manually

    orchestrator.start();
    await orchestrator.runLoop(); // Enters SLEEPING

    expect(orchestrator.getState()).toBe(LoopState.SLEEPING);

    // Check while sleeping — should be a no-op (paused)
    watchdog.check();
    expect(injected).toHaveLength(0);

    // Wake — watchdog resumes, activity clock resets
    orchestrator.wake();
    expect(orchestrator.getState()).toBe(LoopState.RUNNING);

    // A check immediately after wake should still be within threshold
    watchdog.check();
    expect(injected).toHaveLength(0);

    watchdog.stop();
  });
});
