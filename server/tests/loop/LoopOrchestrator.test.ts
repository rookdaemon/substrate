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
import { TickPromptBuilder } from "../../src/session/TickPromptBuilder";
import { InMemorySdkSession } from "../../src/session/InMemorySdkSession";
import { SdkSessionFactory } from "../../src/session/ISdkSession";
import { SdkResultSuccess, SdkAssistantMessage } from "../../src/agents/claude/AgentSdkLauncher";

function createTestDeps() {
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

  const ego = new Ego(reader, writer, appendWriter, checker, promptBuilder, launcher, clock);
  const subconscious = new Subconscious(reader, writer, appendWriter, checker, promptBuilder, launcher, clock);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock);
  const id = new Id(reader, checker, promptBuilder, launcher, clock);

  return { fs, clock, launcher, appendWriter, ego, subconscious, superego, id };
}

async function setupSubstrateFiles(fs: InMemoryFileSystem) {
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

describe("LoopOrchestrator", () => {
  let deps: ReturnType<typeof createTestDeps>;
  let timer: ImmediateTimer;
  let eventSink: InMemoryEventSink;
  let logger: InMemoryLogger;
  let orchestrator: LoopOrchestrator;

  beforeEach(async () => {
    deps = createTestDeps();
    timer = new ImmediateTimer();
    eventSink = new InMemoryEventSink();
    logger = new InMemoryLogger();
    await setupSubstrateFiles(deps.fs);

    orchestrator = new LoopOrchestrator(
      deps.ego,
      deps.subconscious,
      deps.superego,
      deps.id,
      deps.appendWriter,
      deps.clock,
      timer,
      eventSink,
      defaultLoopConfig(),
      logger
    );
  });

  describe("construction + initial state", () => {
    it("starts in STOPPED state", () => {
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("starts with zero metrics", () => {
      const metrics = orchestrator.getMetrics();

      expect(metrics.totalCycles).toBe(0);
      expect(metrics.successfulCycles).toBe(0);
      expect(metrics.failedCycles).toBe(0);
      expect(metrics.idleCycles).toBe(0);
      expect(metrics.consecutiveIdleCycles).toBe(0);
      expect(metrics.superegoAudits).toBe(0);
    });
  });

  describe("state transitions", () => {
    it("start() transitions from STOPPED to RUNNING", () => {
      orchestrator.start();
      expect(orchestrator.getState()).toBe(LoopState.RUNNING);
    });

    it("start() emits state_changed event", () => {
      orchestrator.start();
      const events = eventSink.getEvents();

      expect(events).toHaveLength(1);
      expect(events[0].type).toBe("state_changed");
      expect(events[0].data).toEqual({
        from: LoopState.STOPPED,
        to: LoopState.RUNNING,
      });
    });

    it("pause() transitions from RUNNING to PAUSED", () => {
      orchestrator.start();
      orchestrator.pause();
      expect(orchestrator.getState()).toBe(LoopState.PAUSED);
    });

    it("resume() transitions from PAUSED to RUNNING", () => {
      orchestrator.start();
      orchestrator.pause();
      orchestrator.resume();
      expect(orchestrator.getState()).toBe(LoopState.RUNNING);
    });

    it("stop() transitions from RUNNING to STOPPED", () => {
      orchestrator.start();
      orchestrator.stop();
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("stop() transitions from PAUSED to STOPPED", () => {
      orchestrator.start();
      orchestrator.pause();
      orchestrator.stop();
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("throws when starting while already running", () => {
      orchestrator.start();
      expect(() => orchestrator.start()).toThrow("Cannot start: loop is in RUNNING state");
    });

    it("throws when pausing while stopped", () => {
      expect(() => orchestrator.pause()).toThrow("Cannot pause: loop is in STOPPED state");
    });

    it("throws when resuming while running", () => {
      orchestrator.start();
      expect(() => orchestrator.resume()).toThrow("Cannot resume: loop is in RUNNING state");
    });

    it("throws when resuming while stopped", () => {
      expect(() => orchestrator.resume()).toThrow("Cannot resume: loop is in STOPPED state");
    });

    it("emits events for each transition", () => {
      orchestrator.start();
      orchestrator.pause();
      orchestrator.resume();
      orchestrator.stop();

      const events = eventSink.getEvents().filter(e => e.type === "state_changed");
      expect(events).toHaveLength(4);
      expect(events.map(e => e.data)).toEqual([
        { from: LoopState.STOPPED, to: LoopState.RUNNING },
        { from: LoopState.RUNNING, to: LoopState.PAUSED },
        { from: LoopState.PAUSED, to: LoopState.RUNNING },
        { from: LoopState.RUNNING, to: LoopState.STOPPED },
      ]);
    });

    it("uses clock for event timestamps", () => {
      deps.clock.setNow(new Date("2025-06-15T12:30:00.000Z"));
      orchestrator.start();

      const events = eventSink.getEvents();
      expect(events[0].timestamp).toBe("2025-06-15T12:30:00.000Z");
    });
  });

  describe("runOneCycle — dispatch path", () => {
    it("dispatches task from ego, executes via subconscious, logs progress", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Task A done",
        progressEntry: "Completed Task A",
        skillUpdates: null,
        proposals: [],
      }));

      const result = await orchestrator.runOneCycle();

      expect(result.action).toBe("dispatch");
      expect(result.taskId).toBeDefined();
      expect(result.success).toBe(true);
      expect(result.cycleNumber).toBe(1);
    });

    it("increments metrics on successful dispatch", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Progress",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      const metrics = orchestrator.getMetrics();
      expect(metrics.totalCycles).toBe(1);
      expect(metrics.successfulCycles).toBe(1);
      expect(metrics.consecutiveIdleCycles).toBe(0);
    });

    it("handles task failure gracefully", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "failure",
        summary: "Task failed",
        progressEntry: "",
        skillUpdates: null,
        proposals: [],
      }));

      const result = await orchestrator.runOneCycle();

      expect(result.action).toBe("dispatch");
      expect(result.success).toBe(false);

      const metrics = orchestrator.getMetrics();
      expect(metrics.totalCycles).toBe(1);
      expect(metrics.failedCycles).toBe(1);
    });

    it("writes failure summary to CONVERSATION on failed dispatch", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "failure",
        summary: "Task failed: connection refused",
        progressEntry: "",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      const conversation = await deps.fs.readFile("/substrate/CONVERSATION.md");
      expect(conversation).toContain("[SUBCONSCIOUS] Task failed: connection refused");
    });

    it("emits cycle_complete event", async () => {
      orchestrator.start();
      eventSink.reset();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Progress",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      const events = eventSink.getEvents();
      const cycleEvent = events.find(e => e.type === "cycle_complete");
      expect(cycleEvent).toBeDefined();
      expect(cycleEvent!.data.cycleNumber).toBe(1);
      expect(cycleEvent!.data.action).toBe("dispatch");
    });

    it("marks task complete on success", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Completed",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      // Verify the plan was updated (Task A marked complete)
      const plan = await deps.fs.readFile("/substrate/PLAN.md");
      expect(plan).toContain("[x] Task A");
    });

    it("logs progress on success", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Task A completed successfully",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      const progress = await deps.fs.readFile("/substrate/PROGRESS.md");
      expect(progress).toContain("Task A completed successfully");
    });

    it("updates skills when skillUpdates present", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Progress",
        skillUpdates: "# Skills\n\nLearned TypeScript",
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      const skills = await deps.fs.readFile("/substrate/SKILLS.md");
      expect(skills).toBe("# Skills\n\nLearned TypeScript");
    });

    it("writes task summary to CONVERSATION after successful dispatch", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Implemented the authentication module",
        progressEntry: "Auth done",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      const conversation = await deps.fs.readFile("/substrate/CONVERSATION.md");
      expect(conversation).toContain("[SUBCONSCIOUS] Implemented the authentication module");
    });

    it("evaluates proposals via superego when present", async () => {
      orchestrator.start();

      // Subconscious returns proposals
      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Progress",
        skillUpdates: null,
        proposals: [{ target: "MEMORY", content: "Remember this" }],
      }));

      // Superego evaluates proposals
      deps.launcher.enqueueSuccess(JSON.stringify({
        proposalEvaluations: [{ approved: true, reason: "Looks good" }],
      }));

      await orchestrator.runOneCycle();

      // Should have called launcher twice: subconscious execute + superego evaluate
      expect(deps.launcher.getLaunches()).toHaveLength(2);
    });
  });

  describe("runOneCycle — idle path", () => {
    it("returns idle result when no tasks available", async () => {
      // All tasks complete
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nDone\n\n## Tasks\n- [x] Task A\n- [x] Task B");
      orchestrator.start();

      const result = await orchestrator.runOneCycle();

      expect(result.action).toBe("idle");
      expect(result.success).toBe(true);
      expect(result.summary).toContain("idle");
    });

    it("increments idle metrics", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      orchestrator.start();

      await orchestrator.runOneCycle();

      const metrics = orchestrator.getMetrics();
      expect(metrics.totalCycles).toBe(1);
      expect(metrics.idleCycles).toBe(1);
      expect(metrics.consecutiveIdleCycles).toBe(1);
    });

    it("tracks consecutive idle cycles", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      orchestrator.start();

      await orchestrator.runOneCycle();
      await orchestrator.runOneCycle();
      await orchestrator.runOneCycle();

      const metrics = orchestrator.getMetrics();
      expect(metrics.idleCycles).toBe(3);
      expect(metrics.consecutiveIdleCycles).toBe(3);
    });

    it("resets consecutive idle on successful dispatch", async () => {
      // Start idle
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      orchestrator.start();
      await orchestrator.runOneCycle();
      expect(orchestrator.getMetrics().consecutiveIdleCycles).toBe(1);

      // Add pending task
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [ ] New Task");
      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Progress",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();
      expect(orchestrator.getMetrics().consecutiveIdleCycles).toBe(0);
    });

    it("emits idle event", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      orchestrator.start();
      eventSink.reset();

      await orchestrator.runOneCycle();

      const events = eventSink.getEvents();
      const idleEvent = events.find(e => e.type === "idle");
      expect(idleEvent).toBeDefined();
      expect(idleEvent!.data.consecutiveIdleCycles).toBe(1);
    });
  });

  describe("superego audit scheduling", () => {
    it("triggers audit at configured interval", async () => {
      const config = defaultLoopConfig({ superegoAuditInterval: 3 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );
      orchestrator.start();

      // Run 3 idle cycles (all tasks done)
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");

      // Cycle 1, 2 — no audit
      await orchestrator.runOneCycle();
      await orchestrator.runOneCycle();
      expect(orchestrator.getMetrics().superegoAudits).toBe(0);

      // Cycle 3 — audit triggers
      deps.launcher.enqueueSuccess(JSON.stringify({
        findings: [],
        proposalEvaluations: [],
        summary: "All clear",
      }));

      await orchestrator.runOneCycle();
      expect(orchestrator.getMetrics().superegoAudits).toBe(1);
    });

    it("handles audit failure gracefully", async () => {
      const config = defaultLoopConfig({ superegoAuditInterval: 1 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );
      orchestrator.start();

      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");

      // Audit will try to call launcher — no responses enqueued so it will throw
      // But the orchestrator should not crash
      await orchestrator.runOneCycle();

      // Should still complete the cycle
      expect(orchestrator.getMetrics().totalCycles).toBe(1);
      expect(orchestrator.getMetrics().superegoAudits).toBe(1);
    });

    it("emits audit_complete event", async () => {
      const config = defaultLoopConfig({ superegoAuditInterval: 1 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );
      orchestrator.start();
      eventSink.reset();

      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");

      deps.launcher.enqueueSuccess(JSON.stringify({
        findings: [],
        proposalEvaluations: [],
        summary: "All clear",
      }));

      await orchestrator.runOneCycle();

      const events = eventSink.getEvents();
      const auditEvent = events.find(e => e.type === "audit_complete");
      expect(auditEvent).toBeDefined();
    });
  });

  describe("runLoop", () => {
    it("runs multiple cycles until stopped", async () => {
      // 2 pending tasks → 2 dispatch cycles, then idle cycles until max
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [ ] Task A\n- [ ] Task B");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 2 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );

      // Task A execution
      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Task A done",
        progressEntry: "Did A",
        skillUpdates: null,
        proposals: [],
      }));
      // Task B execution
      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Task B done",
        progressEntry: "Did B",
        skillUpdates: null,
        proposals: [],
      }));

      orchestrator.start();
      await orchestrator.runLoop();

      const metrics = orchestrator.getMetrics();
      expect(metrics.successfulCycles).toBe(2);
      expect(metrics.consecutiveIdleCycles).toBe(2);
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("stops after maxConsecutiveIdleCycles", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 3 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );

      orchestrator.start();
      await orchestrator.runLoop();

      expect(orchestrator.getMetrics().idleCycles).toBe(3);
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("exits on pause", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 100 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );

      orchestrator.start();

      // Pause after first cycle by overriding timer
      let cycleCount = 0;
      const originalDelay = timer.delay.bind(timer);
      timer.delay = async (ms: number) => {
        await originalDelay(ms);
        cycleCount++;
        if (cycleCount >= 2) {
          orchestrator.pause();
        }
      };

      await orchestrator.runLoop();

      expect(orchestrator.getState()).toBe(LoopState.PAUSED);
    });

    it("uses timer delay between cycles", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ cycleDelayMs: 500, maxConsecutiveIdleCycles: 2 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );

      orchestrator.start();
      await orchestrator.runLoop();

      const calls = timer.getCalls();
      expect(calls.length).toBeGreaterThan(0);
      expect(calls.every(c => c === 500)).toBe(true);
    });

    it("backs off until rate limit reset time when rate limited", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [ ] Task A");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 2 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );

      // Task A fails with rate limit message (rawOutput has the limit text)
      deps.launcher.enqueueFailure(
        "Claude Code process exited with code 1",
        "You've hit your limit · resets 7pm (UTC)"
      );

      // Set clock to 6:30pm so backoff should be ~30 minutes
      deps.clock.setNow(new Date("2026-02-09T18:30:00Z"));

      // Stop after the first delay to prevent infinite loop
      const originalDelay = timer.delay.bind(timer);
      timer.delay = async (ms: number) => {
        await originalDelay(ms);
        orchestrator.stop();
      };

      orchestrator.start();
      await orchestrator.runLoop();

      // The delay should be ~30 minutes (1800000ms) for backoff to 7pm
      const calls = timer.getCalls();
      expect(calls[0]).toBe(1800000);

      // Should also log the backoff
      expect(logger.getEntries().some(e => e.includes("rate limited"))).toBe(true);
    });
  });

  describe("runLoop with IdleHandler", () => {
    it("invokes IdleHandler when idle threshold reached and plan is created", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 2 });

      const idleHandler = new IdleHandler(
        deps.id, deps.superego, deps.ego, deps.appendWriter, deps.clock, logger
      );

      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config,
        logger, idleHandler
      );

      // IdleHandler will: detectIdle → idle, generateDrives → 1 goal, superego → approved
      deps.launcher.enqueueSuccess(JSON.stringify({
        goalCandidates: [
          { title: "New Goal", description: "Do something new", priority: "high" },
        ],
      }));

      deps.launcher.enqueueSuccess(JSON.stringify({
        proposalEvaluations: [{ approved: true, reason: "Good" }],
      }));

      // After plan_created, orchestrator resets idle counter and continues.
      // The new plan has a pending task, so next cycle dispatches it.
      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "New Goal done",
        progressEntry: "Completed new goal",
        skillUpdates: null,
        proposals: [],
      }));

      // Then it will go idle again and stop after 2 consecutive idle cycles
      orchestrator.start();
      await orchestrator.runLoop();

      const metrics = orchestrator.getMetrics();
      // 2 idle cycles → handler creates plan → 1 dispatch → 2 more idle cycles → stop
      expect(metrics.successfulCycles).toBe(1);
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("stops when IdleHandler returns no_goals", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 2 });

      const idleHandler = new IdleHandler(
        deps.id, deps.superego, deps.ego, deps.appendWriter, deps.clock, logger
      );

      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config,
        logger, idleHandler
      );

      // IdleHandler → no_goals (no responses enqueued for generateDrives)
      orchestrator.start();
      await orchestrator.runLoop();

      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
      expect(orchestrator.getMetrics().idleCycles).toBe(2);
    });

    it("stops when IdleHandler returns all_rejected", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 2 });

      const idleHandler = new IdleHandler(
        deps.id, deps.superego, deps.ego, deps.appendWriter, deps.clock, logger
      );

      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config,
        logger, idleHandler
      );

      deps.launcher.enqueueSuccess(JSON.stringify({
        goalCandidates: [{ title: "Bad", description: "Bad idea", priority: "low" }],
      }));

      deps.launcher.enqueueSuccess(JSON.stringify({
        proposalEvaluations: [{ approved: false, reason: "Nope" }],
      }));

      orchestrator.start();
      await orchestrator.runLoop();

      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("falls back to stopping when no IdleHandler provided", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 2 });

      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );

      orchestrator.start();
      await orchestrator.runLoop();

      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
      expect(orchestrator.getMetrics().idleCycles).toBe(2);
    });

    it("emits idle_handler event when handler creates plan", async () => {
      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
      const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1 });

      const idleHandler = new IdleHandler(
        deps.id, deps.superego, deps.ego, deps.appendWriter, deps.clock, logger
      );

      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config,
        logger, idleHandler
      );

      deps.launcher.enqueueSuccess(JSON.stringify({
        goalCandidates: [{ title: "Goal", description: "Do it", priority: "high" }],
      }));

      deps.launcher.enqueueSuccess(JSON.stringify({
        proposalEvaluations: [{ approved: true, reason: "OK" }],
      }));

      // Dispatch the new task
      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Did it",
        skillUpdates: null,
        proposals: [],
      }));

      orchestrator.start();
      eventSink.reset();
      await orchestrator.runLoop();

      const events = eventSink.getEvents();
      const idleHandlerEvent = events.find(e => e.type === "idle_handler");
      expect(idleHandlerEvent).toBeDefined();
      expect(idleHandlerEvent!.data.action).toBe("plan_created");
    });
  });

  describe("nudge", () => {
    it("calls timer.wake() to interrupt the delay", () => {
      const wakeSpy = jest.spyOn(timer, "wake");

      orchestrator.nudge();

      expect(wakeSpy).toHaveBeenCalledTimes(1);
    });

    it("logs a debug message", () => {
      orchestrator.nudge();

      expect(logger.getEntries().some(m => m.includes("nudge()"))).toBe(true);
    });
  });

  describe("process_output events", () => {
    it("passes onLogEntry callback to subconscious execute", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Progress",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      // Verify the launcher received a launch with onLogEntry callback
      const launches = deps.launcher.getLaunches();
      expect(launches.length).toBeGreaterThan(0);
      expect(launches[0].options?.onLogEntry).toBeDefined();
    });

    it("emits process_output events with source 'cycle' during runOneCycle", async () => {
      orchestrator.start();

      deps.launcher.enqueueSuccess(JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Progress",
        skillUpdates: null,
        proposals: [],
      }));

      await orchestrator.runOneCycle();

      // Grab the onLogEntry callback and invoke it
      const launches = deps.launcher.getLaunches();
      const onLogEntry = launches[0].options!.onLogEntry!;
      onLogEntry({ type: "text", content: "working..." });

      const events = eventSink.getEvents();
      const processEvent = events.find((e) => e.type === "process_output");
      expect(processEvent).toBeDefined();
      expect(processEvent!.data.source).toBe("cycle");
    });

    it("passes onLogEntry callback tagged with correct role for audit", async () => {
      const config = defaultLoopConfig({ superegoAuditInterval: 1 });
      orchestrator = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink, config, logger
      );
      orchestrator.start();

      await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");

      deps.launcher.enqueueSuccess(JSON.stringify({
        findings: [],
        proposalEvaluations: [],
        summary: "All clear",
      }));

      await orchestrator.runOneCycle();

      // Verify the audit launch also received an onLogEntry callback
      const launches = deps.launcher.getLaunches();
      expect(launches.length).toBeGreaterThan(0);
      expect(launches[0].options?.onLogEntry).toBeDefined();
    });
  });

  describe("injectMessage with launcher", () => {
    it("forwards to launcher.inject() when launcher is set", () => {
      const injected: string[] = [];
      orchestrator.setLauncher({ inject: (msg) => injected.push(msg) });

      orchestrator.injectMessage("hello from user");

      expect(injected).toEqual(["hello from user"]);
    });

    it("emits message_injected event", () => {
      orchestrator.setLauncher({ inject: () => {} });

      orchestrator.injectMessage("test");

      const events = eventSink.getEvents();
      const injectedEvent = events.find((e) => e.type === "message_injected");
      expect(injectedEvent).toBeDefined();
      expect(injectedEvent!.data.message).toBe("test");
    });
  });

  describe("handleUserMessage", () => {
    it("launches ego.respondToMessage and emits conversation_response event", async () => {
      deps.launcher.enqueueSuccess("Hi there, friend!");

      await orchestrator.handleUserMessage("Ji!");

      const events = eventSink.getEvents();
      const responseEvent = events.find((e) => e.type === "conversation_response");
      expect(responseEvent).toBeDefined();
      expect(responseEvent!.data.response).toBe("Hi there, friend!");
    });

    it("appends ego response to CONVERSATION.md", async () => {
      deps.launcher.enqueueSuccess("Hello!");

      await orchestrator.handleUserMessage("Hi");

      const content = await deps.fs.readFile("/substrate/CONVERSATION.md");
      expect(content).toContain("[EGO] Hello!");
    });

    it("emits conversation_response with error on failure", async () => {
      deps.launcher.enqueueFailure("session crashed");

      await orchestrator.handleUserMessage("Hello");

      const events = eventSink.getEvents();
      const responseEvent = events.find((e) => e.type === "conversation_response");
      expect(responseEvent).toBeDefined();
      expect(responseEvent!.data.error).toBeDefined();
    });

    it("passes onLogEntry to ego for process_output events", async () => {
      deps.launcher.enqueueSuccess("Hi!");

      await orchestrator.handleUserMessage("Hello");

      // Verify it was called with onLogEntry by checking the launch
      const launches = deps.launcher.getLaunches();
      expect(launches[0].options?.onLogEntry).toBeDefined();
    });

    it("emits process_output events with source 'conversation'", async () => {
      deps.launcher.enqueueSuccess("Hi!");

      await orchestrator.handleUserMessage("Hello");

      // Grab the onLogEntry callback and invoke it
      const launches = deps.launcher.getLaunches();
      const onLogEntry = launches[0].options!.onLogEntry!;
      onLogEntry({ type: "text", content: "thinking..." });

      const events = eventSink.getEvents();
      const processEvent = events.find((e) => e.type === "process_output");
      expect(processEvent).toBeDefined();
      expect(processEvent!.data.source).toBe("conversation");
      expect(processEvent!.data.role).toBe("EGO");
    });
  });

  describe("graceful stop", () => {
    it("stop() injects persist message before transitioning to STOPPED", () => {
      const injected: string[] = [];
      orchestrator.setLauncher({ inject: (msg) => injected.push(msg) });
      orchestrator.start();

      orchestrator.stop();

      expect(injected.length).toBe(1);
      expect(injected[0]).toContain("Persist");
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("stop() emits persist message event even when no launcher or active session", () => {
      orchestrator.start();
      orchestrator.stop();

      // Check that a message_injected event was emitted with persist content
      const events = eventSink.getEvents();
      const persistEvent = events.find(
        (e) => e.type === "message_injected" && String(e.data.message).includes("Persist")
      );
      expect(persistEvent).toBeDefined();
    });

    it("stop() still works when no launcher or session is set", () => {
      orchestrator.start();
      orchestrator.stop();

      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });
  });

  describe("requestRestart", () => {
    it("injects persist message and calls shutdown callback", () => {
      const injected: string[] = [];
      const shutdownCalls: number[] = [];
      orchestrator.setLauncher({ inject: (msg) => injected.push(msg) });
      orchestrator.setShutdown((code) => shutdownCalls.push(code));
      orchestrator.start();

      orchestrator.requestRestart();

      expect(injected.length).toBe(1);
      expect(injected[0]).toContain("Persist");
      expect(shutdownCalls).toEqual([75]);
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("emits restart_requested event", () => {
      orchestrator.setShutdown(() => {});
      orchestrator.start();

      orchestrator.requestRestart();

      const events = eventSink.getEvents();
      const restartEvent = events.find((e) => e.type === "restart_requested");
      expect(restartEvent).toBeDefined();
    });

    it("works without launcher set", () => {
      const shutdownCalls: number[] = [];
      orchestrator.setShutdown((code) => shutdownCalls.push(code));
      orchestrator.start();

      orchestrator.requestRestart();

      expect(shutdownCalls).toEqual([75]);
      expect(orchestrator.getState()).toBe(LoopState.STOPPED);
    });
  });

  describe("tick mode", () => {
    const successResult: SdkResultSuccess = {
      type: "result",
      subtype: "success",
      result: "done",
      total_cost_usd: 0.05,
      duration_ms: 2000,
    };

    const textMessage: SdkAssistantMessage = {
      type: "assistant",
      message: { content: [{ type: "text", text: "I completed the task" }] },
    };

    function createTickOrchestrator(
      tickDeps: ReturnType<typeof createTestDeps>,
      tickTimer: ImmediateTimer,
      tickEventSink: InMemoryEventSink,
      tickLogger: InMemoryLogger,
      sessionMessages: Parameters<typeof InMemorySdkSession>[0] = [textMessage, successResult],
    ): LoopOrchestrator {
      const substrateConfig = new SubstrateConfig("/substrate");
      const tickReader = new SubstrateFileReader(tickDeps.fs, substrateConfig);
      const tickPromptBuilder = new TickPromptBuilder(tickReader, { substratePath: "/substrate" });

      const session = new InMemorySdkSession(sessionMessages);
      const factory: SdkSessionFactory = () => session;

      const orch = new LoopOrchestrator(
        tickDeps.ego,
        tickDeps.subconscious,
        tickDeps.superego,
        tickDeps.id,
        tickDeps.appendWriter,
        tickDeps.clock,
        tickTimer,
        tickEventSink,
        defaultLoopConfig(),
        tickLogger,
      );

      orch.setTickDependencies({
        tickPromptBuilder,
        sdkSessionFactory: factory,
      });

      return orch;
    }

    it("runOneTick creates session and returns result", async () => {
      const tickOrch = createTickOrchestrator(deps, timer, eventSink, logger);

      const result = await tickOrch.runOneTick();

      expect(result.tickNumber).toBe(1);
      expect(result.success).toBe(true);
      expect(result.durationMs).toBeGreaterThanOrEqual(0);
    });

    it("runOneTick increments tick number", async () => {
      const tickOrch = createTickOrchestrator(deps, timer, eventSink, logger);

      const r1 = await tickOrch.runOneTick();
      const r2 = await tickOrch.runOneTick();

      expect(r1.tickNumber).toBe(1);
      expect(r2.tickNumber).toBe(2);
    });

    it("runOneTick emits tick_started and tick_complete events", async () => {
      const tickOrch = createTickOrchestrator(deps, timer, eventSink, logger);

      await tickOrch.runOneTick();

      const events = eventSink.getEvents();
      const tickStarted = events.find((e) => e.type === "tick_started");
      const tickComplete = events.find((e) => e.type === "tick_complete");

      expect(tickStarted).toBeDefined();
      expect(tickStarted!.data.tickNumber).toBe(1);

      expect(tickComplete).toBeDefined();
      expect(tickComplete!.data.tickNumber).toBe(1);
      expect(tickComplete!.data.success).toBe(true);
    });

    it("runOneTick returns error when session fails", async () => {
      const factory: SdkSessionFactory = () => ({
        async *[Symbol.asyncIterator]() {
          throw new Error("session crashed");
        },
        async streamInput() {},
        close() {},
      });

      const substrateConfig = new SubstrateConfig("/substrate");
      const tickReader = new SubstrateFileReader(deps.fs, substrateConfig);
      const tickPromptBuilder = new TickPromptBuilder(tickReader, { substratePath: "/substrate" });

      const tickOrch = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink,
        defaultLoopConfig(), logger,
      );
      tickOrch.setTickDependencies({ tickPromptBuilder, sdkSessionFactory: factory });

      const result = await tickOrch.runOneTick();

      expect(result.success).toBe(false);
      expect(result.error).toBe("session crashed");
    });

    it("runOneTick throws when tick dependencies not set", async () => {
      // orchestrator from beforeEach has no tick deps
      await expect(orchestrator.runOneTick()).rejects.toThrow("Tick dependencies not configured");
    });

    it("injectMessage forwards to active session manager", async () => {
      const tickOrch = createTickOrchestrator(deps, timer, eventSink, logger);

      // No active session — should just queue
      tickOrch.injectMessage("hello");

      const events = eventSink.getEvents();
      const injected = events.find((e) => e.type === "message_injected");
      expect(injected).toBeDefined();
      expect(injected!.data.message).toBe("hello");
    });

    it("injectMessage queues message when no active session", async () => {
      const tickOrch = createTickOrchestrator(deps, timer, eventSink, logger);

      tickOrch.injectMessage("queued message");

      // Run a tick — the queued message should be injected
      await tickOrch.runOneTick();

      expect(logger.getEntries().some((e) => e.includes("queued message"))).toBe(true);
    });

    it("runTickLoop runs multiple ticks with delays", async () => {
      let tickCount = 0;
      const maxTicks = 2;

      const substrateConfig = new SubstrateConfig("/substrate");
      const tickReader = new SubstrateFileReader(deps.fs, substrateConfig);
      const tickPromptBuilder = new TickPromptBuilder(tickReader, { substratePath: "/substrate" });

      // Use a variable to hold the orchestrator reference (hoisted for factory closure)
      let tickOrch: LoopOrchestrator;

      const factory: SdkSessionFactory = () => {
        tickCount++;
        if (tickCount >= maxTicks) {
          // Stop directly — synchronous call before returning session
          tickOrch.stop();
        }
        return new InMemorySdkSession([textMessage, successResult]);
      };

      tickOrch = new LoopOrchestrator(
        deps.ego, deps.subconscious, deps.superego, deps.id,
        deps.appendWriter, deps.clock, timer, eventSink,
        defaultLoopConfig(), logger,
      );
      tickOrch.setTickDependencies({ tickPromptBuilder, sdkSessionFactory: factory });
      tickOrch.start();

      await tickOrch.runTickLoop();

      expect(tickCount).toBe(maxTicks);
    });
  });
});
