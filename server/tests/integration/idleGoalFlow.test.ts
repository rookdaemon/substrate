import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { IdleHandler } from "../../src/loop/IdleHandler";
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

  const ego = new Ego(reader, writer, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier);
  const subconscious = new Subconscious(reader, writer, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier);
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

describe("Integration: Idle → Goal Flow", () => {
  it("idle triggers IdleHandler, generates goals, writes new plan, dispatches new task", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const idleHandler = new IdleHandler(
      deps.id, deps.superego, deps.ego, deps.clock, logger
    );

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1 });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    // IdleHandler: Id.generateDrives → 1 goal
    deps.launcher.enqueueSuccess(JSON.stringify({
      goalCandidates: [{ title: "Explore new topic", description: "Learn something new", priority: "high" }],
    }));

    // IdleHandler: Superego.evaluateProposals → approved
    deps.launcher.enqueueSuccess(JSON.stringify({
      proposalEvaluations: [{ approved: true, reason: "Good goal" }],
    }));

    // After plan_created, loop dispatches the new task
    deps.launcher.enqueueSuccess(JSON.stringify({
      result: "success",
      summary: "Explored new topic",
      progressEntry: "Learned about new topic",
      skillUpdates: null,
      proposals: [],
    }));

    orchestrator.start();
    await orchestrator.runLoop();

    // Verify the new plan was written with the goal
    const plan = await deps.fs.readFile("/substrate/PLAN.md");
    expect(plan).toContain("Explore new topic");

    // Verify progress was logged
    const progress = await deps.fs.readFile("/substrate/PROGRESS.md");
    expect(progress).toContain("Learned about new topic");

    // Metrics should show the dispatch after idle recovery
    expect(orchestrator.getMetrics().successfulCycles).toBe(1);
  });

  it("stops when IdleHandler produces no goals", async () => {
    const deps = createDeps();
    await setupIdleSubstrate(deps.fs);

    const logger = new InMemoryLogger();
    const idleHandler = new IdleHandler(
      deps.id, deps.superego, deps.ego, deps.clock, logger
    );

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ maxConsecutiveIdleCycles: 1 });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      config, logger, idleHandler
    );

    // Id.generateDrives will fail (no runner responses) → no_goals
    orchestrator.start();
    await orchestrator.runLoop();

    expect(orchestrator.getMetrics().idleCycles).toBe(1);
  });
});
