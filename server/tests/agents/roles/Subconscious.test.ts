import { Subconscious } from "../../../src/agents/roles/Subconscious";
import { PermissionChecker } from "../../../src/agents/permissions";
import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { TaskClassifier } from "../../../src/agents/TaskClassifier";
import { ConversationManager } from "../../../src/conversation/ConversationManager";
import { IConversationCompactor } from "../../../src/conversation/IConversationCompactor";

// Mock compactor for ConversationManager
class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

describe("Subconscious agent", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let launcher: InMemorySessionLauncher;
  let subconscious: Subconscious;

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
    const compactor = new MockCompactor();
    const conversationManager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock
    );

    subconscious = new Subconscious(
      reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace"
    );

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
  });

  describe("execute", () => {
    it("sends task to Claude and parses TaskResult", async () => {
      const claudeResponse = JSON.stringify({
        result: "success",
        summary: "Implemented the feature",
        progressEntry: "Completed task A implementation",
        skillUpdates: null,
        proposals: [],
      });
      launcher.enqueueSuccess(claudeResponse);

      const result = await subconscious.execute({
        taskId: "task-1",
        description: "Implement task A",
      });

      expect(result.result).toBe("success");
      expect(result.summary).toBe("Implemented the feature");
    });

    it("passes substratePath as cwd to session launcher", async () => {
      launcher.enqueueSuccess(JSON.stringify({
        result: "success", summary: "Done", progressEntry: "", skillUpdates: null, proposals: [],
      }));

      await subconscious.execute({ taskId: "task-1", description: "Do it" });

      const launches = launcher.getLaunches();
      expect(launches[0].options?.cwd).toBe("/workspace");
    });

    it("returns failure result with stderr when Claude fails", async () => {
      launcher.enqueueFailure("claude: model not found");

      const result = await subconscious.execute({
        taskId: "task-1",
        description: "Implement task A",
      });

      expect(result.result).toBe("failure");
      expect(result.summary).toContain("claude: model not found");
    });

    it("returns failure result with error message on parse error", async () => {
      launcher.enqueueSuccess("not valid json");

      const result = await subconscious.execute({
        taskId: "task-1",
        description: "Implement task A",
      });

      expect(result.result).toBe("failure");
      expect(result.summary).toMatch(/JSON|Unexpected|parse/i);
    });

    it("includes proposals in the result", async () => {
      const claudeResponse = JSON.stringify({
        result: "success",
        summary: "Done",
        progressEntry: "Finished",
        skillUpdates: null,
        proposals: [
          { target: "MEMORY", content: "Learned something new" },
        ],
      });
      launcher.enqueueSuccess(claudeResponse);

      const result = await subconscious.execute({
        taskId: "task-1",
        description: "Do something",
      });

      expect(result.proposals).toHaveLength(1);
      expect(result.proposals[0].target).toBe("MEMORY");
    });
  });

  describe("logProgress", () => {
    it("appends progress entry to PROGRESS", async () => {
      await subconscious.logProgress("Started working on task A");

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("[2025-06-15T10:00:00.000Z]");
      expect(content).toContain("[SUBCONSCIOUS] Started working on task A");
    });
  });

  describe("markTaskComplete", () => {
    it("updates the plan with the task marked complete", async () => {
      await subconscious.markTaskComplete("task-1");

      const content = await fs.readFile("/substrate/PLAN.md");
      expect(content).toContain("- [x] Task A");
      expect(content).toContain("- [ ] Task B");
    });
  });

  describe("logConversation", () => {
    it("appends conversation entry to CONVERSATION", async () => {
      await subconscious.logConversation("Task completed successfully");

      const content = await fs.readFile("/substrate/CONVERSATION.md");
      expect(content).toContain("[2025-06-15T10:00:00.000Z]");
      expect(content).toContain("[SUBCONSCIOUS] Task completed successfully");
    });
  });

  describe("updateSkills", () => {
    it("overwrites SKILLS.md with new content", async () => {
      await subconscious.updateSkills("# Skills\n\n## TypeScript\n\nProficient");

      const content = await fs.readFile("/substrate/SKILLS.md");
      expect(content).toContain("## TypeScript");
      expect(content).toContain("Proficient");
    });
  });

  describe("computeDriveRating", () => {
    it("returns baseline 5 for a successful task with no special signals", () => {
      const rating = Subconscious.computeDriveRating({
        result: "success",
        summary: "Done",
        progressEntry: "Completed something",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      });
      expect(rating).toBe(5);
    });

    it("adds 3 points when skill or memory updates are present", () => {
      const rating = Subconscious.computeDriveRating({
        result: "success",
        summary: "Learned something",
        progressEntry: "Read papers",
        skillUpdates: "# Skills\nupdated",
        memoryUpdates: null,
        proposals: [],
      });
      expect(rating).toBe(8);
    });

    it("subtracts 2 points for failed tasks", () => {
      const rating = Subconscious.computeDriveRating({
        result: "failure",
        summary: "Blocked",
        progressEntry: "Could not complete",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      });
      expect(rating).toBe(3);
    });

    it("adds 4 points for blog/PR progress entries", () => {
      const rating = Subconscious.computeDriveRating({
        result: "success",
        summary: "Wrote a blog post",
        progressEntry: "Published blog about alignment",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      });
      expect(rating).toBe(9);
    });

    it("clamps score to the 0-10 range", () => {
      // Max: 5 + 3 + 4 = 12 → clamped to 10
      const maxRating = Subconscious.computeDriveRating({
        result: "success",
        summary: "Did everything",
        progressEntry: "Merged a PR and wrote blog",
        skillUpdates: "updated",
        memoryUpdates: null,
        proposals: [],
      });
      expect(maxRating).toBe(10);

      // Min: 5 - 2 = 3, but with no bonus → 3 (already above 0)
      const minRating = Subconscious.computeDriveRating({
        result: "failure",
        summary: "Bad",
        progressEntry: "Failed attempt",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      });
      expect(minRating).toBe(3);
    });
  });
});
