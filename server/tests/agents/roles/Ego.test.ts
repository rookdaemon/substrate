import { Ego } from "../../../src/agents/roles/Ego";
import { PermissionChecker } from "../../../src/agents/permissions";
import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { ConversationManager } from "../../../src/conversation/ConversationManager";
import { ConversationCompactor } from "../../../src/conversation/ConversationCompactor";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { AgentRole } from "../../../src/agents/types";
import { ProcessLogEntry } from "../../../src/agents/claude/ISessionLauncher";
import { TaskClassifier } from "../../../src/agents/TaskClassifier";

describe("Ego agent", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let launcher: InMemorySessionLauncher;
  let ego: Ego;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
    launcher = new InMemorySessionLauncher();
    const config = new SubstrateConfig("/substrate");
    const reader = new SubstrateFileReader(fs, config);
    const lock = new FileLock();
    const writer = new SubstrateFileWriter(fs, config, lock);
    const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);
    const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
    
    // Create ConversationCompactor and ConversationManager
    const compactor = new ConversationCompactor(launcher, "/workspace");
    const conversationManager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock
    );

    ego = new Ego(
      reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace"
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
      launcher.enqueueSuccess(claudeResponse);

      const decision = await ego.decide();
      expect(decision.action).toBe("dispatch");
    });

    it("returns idle decision with stderr when Claude fails", async () => {
      launcher.enqueueFailure("claude: rate limited");

      const decision = await ego.decide();
      expect(decision.action).toBe("idle");
      expect(decision.reason).toContain("claude: rate limited");
    });

    it("returns idle decision with error message on invalid JSON", async () => {
      launcher.enqueueSuccess("not json");

      const decision = await ego.decide();
      expect(decision.action).toBe("idle");
      expect(decision.reason).toMatch(/JSON|Unexpected|parse/i);
    });

    it("passes substratePath as cwd to session launcher", async () => {
      launcher.enqueueSuccess(JSON.stringify({ action: "idle" }));

      await ego.decide();

      const launches = launcher.getLaunches();
      expect(launches[0].options?.cwd).toBe("/workspace");
    });

    it("forwards onLogEntry callback to session launcher", async () => {
      launcher.enqueueSuccess(JSON.stringify({ action: "idle" }));

      const logEntries: ProcessLogEntry[] = [];
      await ego.decide((entry) => logEntries.push(entry));

      // InMemorySessionLauncher doesn't emit log entries,
      // but we verify the callback was passed by checking the recorded launch
      const launches = launcher.getLaunches();
      expect(launches[0].options?.onLogEntry).toBeDefined();
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

  describe("respondToMessage", () => {
    it("launches a session with the user message and appends response to CONVERSATION", async () => {
      launcher.enqueueSuccess("Hello! How can I help you today?");

      await ego.respondToMessage("Ji!");

      const content = await fs.readFile("/substrate/CONVERSATION.md");
      expect(content).toContain("[EGO] Hello! How can I help you today?");
    });

    it("includes the user message in the launch prompt", async () => {
      launcher.enqueueSuccess("Hi there!");

      await ego.respondToMessage("Ji!");

      const launches = launcher.getLaunches();
      expect(launches[0].request.message).toContain("Ji!");
    });

    it("passes onLogEntry callback to the session", async () => {
      launcher.enqueueSuccess("Response");

      const entries: ProcessLogEntry[] = [];
      await ego.respondToMessage("Hi", (e) => entries.push(e));

      const launches = launcher.getLaunches();
      expect(launches[0].options?.onLogEntry).toBeDefined();
    });

    it("does not append on session failure", async () => {
      launcher.enqueueFailure("session crashed");

      await ego.respondToMessage("Hello");

      const content = await fs.readFile("/substrate/CONVERSATION.md");
      expect(content).not.toContain("session crashed");
    });

    it("passes cwd to session launcher", async () => {
      launcher.enqueueSuccess("Hi!");

      await ego.respondToMessage("Hello");

      const launches = launcher.getLaunches();
      expect(launches[0].options?.cwd).toBe("/workspace");
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
