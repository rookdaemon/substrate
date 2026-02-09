import { Ego } from "../../../src/agents/roles/Ego";
import { PermissionChecker } from "../../../src/agents/permissions";
import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../../../src/agents/claude/ClaudeSessionLauncher";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { AgentRole } from "../../../src/agents/types";
import { ProcessLogEntry } from "../../../src/agents/claude/StreamJsonParser";
import { asStreamJson } from "../../helpers/streamJson";

describe("Ego agent", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let runner: InMemoryProcessRunner;
  let ego: Ego;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
    runner = new InMemoryProcessRunner();
    const config = new SubstrateConfig("/substrate");
    const reader = new SubstrateFileReader(fs, config);
    const lock = new FileLock();
    const writer = new SubstrateFileWriter(fs, config, lock);
    const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);
    const launcher = new ClaudeSessionLauncher(runner, clock);

    ego = new Ego(
      reader, writer, appendWriter, checker, promptBuilder, launcher, clock, "/workspace"
    );

    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] Task A\n- [ ] Task B\n- [x] Task C");
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
  });

  describe("decide", () => {
    it("sends context to Claude and returns an EgoDecision", async () => {
      const claudeResponse = JSON.stringify({
        action: "dispatch",
        taskId: "task-1",
        description: "Implement task A",
      });
      runner.enqueue({ stdout: asStreamJson(claudeResponse), stderr: "", exitCode: 0 });

      const decision = await ego.decide();
      expect(decision.action).toBe("dispatch");
    });

    it("returns idle decision with stderr when Claude fails", async () => {
      runner.enqueue({ stdout: "", stderr: "claude: rate limited", exitCode: 1 });

      const decision = await ego.decide();
      expect(decision.action).toBe("idle");
      expect(decision.reason).toContain("claude: rate limited");
    });

    it("returns idle decision with error message on invalid JSON", async () => {
      runner.enqueue({ stdout: asStreamJson("not json"), stderr: "", exitCode: 0 });

      const decision = await ego.decide();
      expect(decision.action).toBe("idle");
      expect(decision.reason).toMatch(/JSON|Unexpected|parse/i);
    });

    it("passes substratePath as cwd to session launcher", async () => {
      runner.enqueue({ stdout: asStreamJson(JSON.stringify({ action: "idle" })), stderr: "", exitCode: 0 });

      await ego.decide();

      const calls = runner.getCalls();
      expect(calls[0].options?.cwd).toBe("/workspace");
    });

    it("forwards onLogEntry callback to session launcher", async () => {
      const assistantLine = JSON.stringify({
        type: "assistant",
        message: {
          content: [
            { type: "thinking", thinking: "analyzing" },
            { type: "text", text: '{"action":"idle"}' },
          ],
        },
      });
      const resultLine = JSON.stringify({
        type: "result",
        subtype: "success",
        result: '{"action":"idle"}',
        total_cost_usd: 0,
        duration_ms: 0,
      });
      runner.enqueue({ stdout: `${assistantLine}\n${resultLine}\n`, stderr: "", exitCode: 0 });

      const logEntries: ProcessLogEntry[] = [];
      await ego.decide((entry) => logEntries.push(entry));

      expect(logEntries.length).toBeGreaterThan(0);
      expect(logEntries[0].type).toBe("thinking");
    });
  });

  describe("readPlan", () => {
    it("reads the current plan content", async () => {
      const plan = await ego.readPlan();
      expect(plan).toContain("# Plan");
      expect(plan).toContain("Task A");
    });
  });

  describe("writePlan", () => {
    it("writes new plan content", async () => {
      const newPlan = "# Plan\n\n## Current Goal\nNew goal\n\n## Tasks\n- [ ] New task";
      await ego.writePlan(newPlan);

      const content = await fs.readFile("/substrate/PLAN.md");
      expect(content).toContain("New goal");
      expect(content).toContain("New task");
    });

    it("enforces WRITE permission for EGO on PLAN", async () => {
      const newPlan = "# Plan\n\n## Current Goal\nGoal\n\n## Tasks\n- [ ] Task";
      await expect(ego.writePlan(newPlan)).resolves.not.toThrow();
    });
  });

  describe("appendConversation", () => {
    it("appends an entry to CONVERSATION", async () => {
      await ego.appendConversation("User asked about deployment");

      const content = await fs.readFile("/substrate/CONVERSATION.md");
      expect(content).toContain("[2025-06-15T10:00:00.000Z]");
      expect(content).toContain("[EGO] User asked about deployment");
    });
  });

  describe("dispatchNext", () => {
    it("returns the next actionable task from the plan", async () => {
      const dispatch = await ego.dispatchNext();
      expect(dispatch).toBeDefined();
      expect(dispatch!.taskId).toBe("task-1");
      expect(dispatch!.description).toBe("Task A");
      expect(dispatch!.targetRole).toBe(AgentRole.SUBCONSCIOUS);
    });

    it("returns null when all tasks are complete", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nDone\n\n## Tasks\n- [x] Done");
      const dispatch = await ego.dispatchNext();
      expect(dispatch).toBeNull();
    });

    it("returns null when plan has no tasks", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nNothing\n\n## Tasks\n");
      const dispatch = await ego.dispatchNext();
      expect(dispatch).toBeNull();
    });
  });
});
