import { IdleHandler } from "../../src/loop/IdleHandler";
import { Id } from "../../src/agents/roles/Id";
import { Superego } from "../../src/agents/roles/Superego";
import { Ego } from "../../src/agents/roles/Ego";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryProcessRunner } from "../../src/agents/claude/InMemoryProcessRunner";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../src/substrate/io/FileLock";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../../src/agents/claude/ClaudeSessionLauncher";
import { asStreamJson } from "../helpers/streamJson";

function createTestDeps() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
  const runner = new InMemoryProcessRunner();
  const config = new SubstrateConfig("/substrate");
  const reader = new SubstrateFileReader(fs, config);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, config, lock);
  const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker);
  const launcher = new ClaudeSessionLauncher(runner, clock);

  const ego = new Ego(reader, writer, appendWriter, checker, promptBuilder, launcher, clock);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock);
  const id = new Id(reader, checker, promptBuilder, launcher, clock);

  return { fs, clock, runner, appendWriter, ego, superego, id };
}

async function setupSubstrateFiles(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [x] Done");
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

describe("IdleHandler", () => {
  let deps: ReturnType<typeof createTestDeps>;
  let handler: IdleHandler;

  beforeEach(async () => {
    deps = createTestDeps();
    await setupSubstrateFiles(deps.fs);
    handler = new IdleHandler(deps.id, deps.superego, deps.ego, deps.appendWriter, deps.clock);
  });

  it("returns no_goals when Id detects not idle", async () => {
    // Plan has pending tasks — not idle
    await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [ ] Pending task");

    const result = await handler.handleIdle();

    expect(result.action).toBe("not_idle");
  });

  it("returns no_goals when Id generates no drives", async () => {
    // Plan is complete — idle
    // Id.generateDrives returns empty because runner has no enqueued response
    const result = await handler.handleIdle();

    expect(result.action).toBe("no_goals");
  });

  it("creates plan from approved goals", async () => {
    // Id.generateDrives returns goals
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        goalCandidates: [
          { title: "Learn Rust", description: "Study the Rust programming language", priority: "high" },
          { title: "Write docs", description: "Document the API", priority: "medium" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    // Superego evaluates proposals — approves first, rejects second
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        proposalEvaluations: [
          { approved: true, reason: "Aligned with values" },
          { approved: false, reason: "Not a priority" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    const result = await handler.handleIdle();

    expect(result.action).toBe("plan_created");
    expect(result.goalCount).toBe(1);

    // Verify plan was written with approved goal
    const plan = await deps.fs.readFile("/substrate/PLAN.md");
    expect(plan).toContain("Learn Rust");
    expect(plan).not.toContain("Write docs");
  });

  it("returns all_rejected when superego rejects all goals", async () => {
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        goalCandidates: [
          { title: "Bad idea", description: "Do something wrong", priority: "high" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        proposalEvaluations: [
          { approved: false, reason: "Against values" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    const result = await handler.handleIdle();

    expect(result.action).toBe("all_rejected");
  });

  it("logs idle handling to PROGRESS", async () => {
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        goalCandidates: [
          { title: "Learn Rust", description: "Study Rust", priority: "high" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        proposalEvaluations: [
          { approved: true, reason: "Good idea" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    await handler.handleIdle();

    const progress = await deps.fs.readFile("/substrate/PROGRESS.md");
    expect(progress).toContain("[ID] Idle detected");
  });

  it("creates plan with multiple approved goals", async () => {
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        goalCandidates: [
          { title: "Goal A", description: "Do A", priority: "high" },
          { title: "Goal B", description: "Do B", priority: "medium" },
          { title: "Goal C", description: "Do C", priority: "low" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        proposalEvaluations: [
          { approved: true, reason: "Good" },
          { approved: true, reason: "Good" },
          { approved: false, reason: "Bad" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    const result = await handler.handleIdle();

    expect(result.action).toBe("plan_created");
    expect(result.goalCount).toBe(2);

    const plan = await deps.fs.readFile("/substrate/PLAN.md");
    expect(plan).toContain("Goal A");
    expect(plan).toContain("Goal B");
    expect(plan).not.toContain("Goal C");
  });

  it("handles Id.generateDrives error gracefully", async () => {
    // Runner throws because no responses enqueued
    const result = await handler.handleIdle();

    expect(result.action).toBe("no_goals");
  });

  it("handles Superego.evaluateProposals error gracefully", async () => {
    deps.runner.enqueue({
      stdout: asStreamJson(JSON.stringify({
        goalCandidates: [
          { title: "Goal A", description: "Do A", priority: "high" },
        ],
      })),
      stderr: "",
      exitCode: 0,
    });

    // Runner will throw on Superego call — no enqueued response

    const result = await handler.handleIdle();

    // Superego error returns all rejected
    expect(result.action).toBe("all_rejected");
  });

  it("handles plan with empty task list as idle", async () => {
    await deps.fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n");

    const result = await handler.handleIdle();

    // Empty plan = idle, but no drives generated
    expect(result.action).toBe("no_goals");
  });
});
