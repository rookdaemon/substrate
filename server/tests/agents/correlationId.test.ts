import { generateCorrelationId } from "../../src/agents/types";
import { Id } from "../../src/agents/roles/Id";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateConfig } from "../../src/substrate/config";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { TaskClassifier } from "../../src/agents/TaskClassifier";
import { PlanParser } from "../../src/agents/parsers/PlanParser";
import { Ego } from "../../src/agents/roles/Ego";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { ConversationManager } from "../../src/conversation/ConversationManager";
import { ConversationCompactor } from "../../src/conversation/ConversationCompactor";
import { FileLock } from "../../src/substrate/io/FileLock";
import { IdleHandler } from "../../src/loop/IdleHandler";
import { Superego } from "../../src/agents/roles/Superego";
import { InMemoryLogger } from "../../src/logging";

describe("Correlation IDs", () => {
  describe("generateCorrelationId", () => {
    it("returns an ID matching the drive-<timestamp>-<random> format", () => {
      const id = generateCorrelationId();
      expect(id).toMatch(/^drive-\d+-[a-z0-9]{6}$/);
    });

    it("generates unique IDs", () => {
      const ids = new Set(Array.from({ length: 20 }, () => generateCorrelationId()));
      expect(ids.size).toBe(20);
    });
  });

  describe("Id.generateDrives — correlation ID assignment", () => {
    let fs: InMemoryFileSystem;
    let launcher: InMemorySessionLauncher;
    let id: Id;

    beforeEach(async () => {
      fs = new InMemoryFileSystem();
      launcher = new InMemorySessionLauncher();
      const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
      const config = new SubstrateConfig("/substrate");
      const reader = new SubstrateFileReader(fs, config);
      const checker = new PermissionChecker();
      const promptBuilder = new PromptBuilder(reader, checker);
      const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });

      id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace");

      await fs.mkdir("/substrate", { recursive: true });
      const files: Record<string, string> = {
        "PLAN.md": "# Plan\n\n## Current Goal\nBuild\n\n## Tasks\n- [ ] Do stuff",
        "MEMORY.md": "# Memory\n",
        "HABITS.md": "# Habits\n",
        "SKILLS.md": "# Skills\n",
        "VALUES.md": "# Values\n",
        "ID.md": "# Id\n",
        "SECURITY.md": "# Security\n",
        "CHARTER.md": "# Charter\n",
        "SUPEREGO.md": "# Superego\n",
        "CLAUDE.md": "# Claude\n",
        "PROGRESS.md": "# Progress\n",
        "CONVERSATION.md": "# Conversation\n",
      };
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(`/substrate/${name}`, content);
      }
    });

    it("assigns a correlationId to each returned GoalCandidate", async () => {
      launcher.enqueueSuccess(JSON.stringify({
        goalCandidates: [
          { title: "Learn TypeScript", description: "Improve skills", priority: "high", confidence: 85 },
          { title: "Write docs", description: "Document system", priority: "medium", confidence: 90 },
        ],
      }));

      const { candidates: drives } = await id.generateDrives();
      expect(drives).toHaveLength(2);
      expect(drives[0].correlationId).toMatch(/^drive-\d+-[a-z0-9]{6}$/);
      expect(drives[1].correlationId).toMatch(/^drive-\d+-[a-z0-9]{6}$/);
    });

    it("assigns unique correlationIds to each candidate", async () => {
      launcher.enqueueSuccess(JSON.stringify({
        goalCandidates: [
          { title: "Goal A", description: "Do A", priority: "high", confidence: 80 },
          { title: "Goal B", description: "Do B", priority: "low", confidence: 60 },
        ],
      }));

      const { candidates: drives } = await id.generateDrives();
      expect(drives[0].correlationId).not.toBe(drives[1].correlationId);
    });

    it("returns empty array (not throwing) on failure — backward compatible", async () => {
      launcher.enqueueFailure("error");
      const { candidates: drives } = await id.generateDrives();
      expect(drives).toEqual([]);
    });
  });

  describe("PlanParser — correlation ID extraction", () => {
    it("extracts correlationId from HTML comment after task line", () => {
      const plan = `# Plan\n\n## Tasks\n- [ ] Do something\n  <!-- correlationId: drive-1234-abc123 -->`;
      const tasks = PlanParser.parseTasks(plan);
      expect(tasks[0].correlationId).toBe("drive-1234-abc123");
    });

    it("works without correlation ID comment — backward compatible", () => {
      const plan = `# Plan\n\n## Tasks\n- [ ] Do something`;
      const tasks = PlanParser.parseTasks(plan);
      expect(tasks[0].correlationId).toBeUndefined();
    });

    it("handles multiple tasks with mixed correlation IDs", () => {
      const plan = [
        "# Plan",
        "",
        "## Tasks",
        "- [ ] Task with ID",
        "  <!-- correlationId: drive-111-aaaaaa -->",
        "- [ ] Task without ID",
        "- [x] Completed task with ID",
        "  <!-- correlationId: drive-222-bbbbbb -->",
      ].join("\n");
      const tasks = PlanParser.parseTasks(plan);
      expect(tasks[0].correlationId).toBe("drive-111-aaaaaa");
      expect(tasks[1].correlationId).toBeUndefined();
      expect(tasks[2].correlationId).toBe("drive-222-bbbbbb");
    });
  });

  describe("Ego.dispatchNext — correlation ID propagation", () => {
    let fs: InMemoryFileSystem;
    let ego: Ego;

    beforeEach(async () => {
      fs = new InMemoryFileSystem();
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
      const compactor = new ConversationCompactor(launcher, "/workspace");
      const conversationManager = new ConversationManager(
        reader, fs, config, lock, appendWriter, checker, compactor, clock
      );
      ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace");

      await fs.mkdir("/substrate", { recursive: true });
      const files: Record<string, string> = {
        "MEMORY.md": "# Memory\n", "HABITS.md": "# Habits\n", "SKILLS.md": "# Skills\n",
        "VALUES.md": "# Values\n", "ID.md": "# Id\n", "SECURITY.md": "# Security\n",
        "CHARTER.md": "# Charter\n", "SUPEREGO.md": "# Superego\n", "CLAUDE.md": "# Claude\n",
        "PROGRESS.md": "# Progress\n", "CONVERSATION.md": "# Conversation\n",
      };
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(`/substrate/${name}`, content);
      }
    });

    it("includes correlationId in DispatchResult when plan task has one", async () => {
      await fs.writeFile("/substrate/PLAN.md", [
        "# Plan",
        "",
        "## Tasks",
        "- [ ] Do the thing",
        "  <!-- correlationId: drive-999-xyz123 -->",
      ].join("\n"));

      const result = await ego.dispatchNext();
      expect(result.dispatch).not.toBeNull();
      expect(result.dispatch!.correlationId).toBe("drive-999-xyz123");
    });

    it("omits correlationId when task has none — backward compatible", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [ ] Do the thing");

      const result = await ego.dispatchNext();
      expect(result.dispatch).not.toBeNull();
      expect(result.dispatch!.correlationId).toBeUndefined();
    });
  });

  describe("IdleHandler — embeds correlationId in plan", () => {
    it("writes correlation ID comment after task line in generated plan", async () => {
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
      const compactor = new ConversationCompactor(launcher, "/workspace");
      const conversationManager = new ConversationManager(
        reader, fs, config, lock, appendWriter, checker, compactor, clock
      );
      const ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace");
      const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, writer, "/workspace");
      const idAgent = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace");
      const logger = new InMemoryLogger();
      const handler = new IdleHandler(idAgent, superego, ego, clock, logger);

      await fs.mkdir("/substrate", { recursive: true });
      const files: Record<string, string> = {
        "PLAN.md": "# Plan\n\n## Tasks\n",
        "MEMORY.md": "# Memory\n", "HABITS.md": "# Habits\n", "SKILLS.md": "# Skills\n",
        "VALUES.md": "# Values\n", "ID.md": "# Id\n", "SECURITY.md": "# Security\n",
        "CHARTER.md": "# Charter\n", "SUPEREGO.md": "# Superego\n", "CLAUDE.md": "# Claude\n",
        "PROGRESS.md": "# Progress\n", "CONVERSATION.md": "# Conversation\n",
        "ESCALATE_TO_STEFAN.md": "# Escalate\n",
      };
      for (const [name, content] of Object.entries(files)) {
        await fs.writeFile(`/substrate/${name}`, content);
      }

      // Id generates one candidate with a correlationId (assigned by generateDrives)
      launcher.enqueueSuccess(JSON.stringify({
        goalCandidates: [{ title: "Build feature", description: "Implement it", priority: "high", confidence: 90 }],
      }));
      // Superego approves it
      launcher.enqueueSuccess(JSON.stringify({
        proposalEvaluations: [{ approved: true, reason: "Looks good" }],
      }));

      const result = await handler.handleIdle();
      expect(result.action).toBe("plan_created");

      const planContent = await fs.readFile("/substrate/PLAN.md", "utf-8");
      // Should contain a correlation ID comment
      expect(planContent).toMatch(/<!-- correlationId: drive-\d+-[a-z0-9]{6} -->/);
    });
  });
});
