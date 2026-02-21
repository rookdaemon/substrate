import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { IdleHandler } from "../../src/loop/IdleHandler";
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

  it("stops (not sleeps) when idle sleep is disabled", async () => {
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

    // Should be STOPPED not SLEEPING
    expect(orchestrator.getState()).toBe(LoopState.STOPPED);
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
