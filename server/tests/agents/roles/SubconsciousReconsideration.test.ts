import { Subconscious, TaskResult, OutcomeEvaluation } from "../../../src/agents/roles/Subconscious";
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

describe("Subconscious reconsideration", () => {
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

    subconscious = new Subconscious(
      reader, writer, appendWriter, checker, promptBuilder, launcher, clock, "/workspace"
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

  describe("evaluateOutcome", () => {
    it("evaluates successful task outcome with high quality", async () => {
      const evaluation = JSON.stringify({
        outcomeMatchesIntent: true,
        qualityScore: 95,
        issuesFound: [],
        recommendedActions: [],
        needsReassessment: false,
      });
      launcher.enqueueSuccess(evaluation);

      const taskResult: TaskResult = {
        result: "success",
        summary: "Implemented feature successfully",
        progressEntry: "Completed implementation with all tests passing",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };

      const outcome = await subconscious.evaluateOutcome(
        { taskId: "task-1", description: "Implement feature X" },
        taskResult
      );

      expect(outcome.outcomeMatchesIntent).toBe(true);
      expect(outcome.qualityScore).toBe(95);
      expect(outcome.issuesFound).toHaveLength(0);
      expect(outcome.needsReassessment).toBe(false);
    });

    it("identifies quality issues in partial success", async () => {
      const evaluation = JSON.stringify({
        outcomeMatchesIntent: false,
        qualityScore: 60,
        issuesFound: ["Tests are incomplete", "Documentation missing"],
        recommendedActions: ["Write missing tests", "Add documentation"],
        needsReassessment: true,
      });
      launcher.enqueueSuccess(evaluation);

      const taskResult: TaskResult = {
        result: "partial",
        summary: "Partially implemented feature",
        progressEntry: "Core logic done but tests incomplete",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };

      const outcome = await subconscious.evaluateOutcome(
        { taskId: "task-2", description: "Implement feature Y" },
        taskResult
      );

      expect(outcome.outcomeMatchesIntent).toBe(false);
      expect(outcome.qualityScore).toBe(60);
      expect(outcome.issuesFound).toHaveLength(2);
      expect(outcome.issuesFound).toContain("Tests are incomplete");
      expect(outcome.recommendedActions).toContain("Write missing tests");
      expect(outcome.needsReassessment).toBe(true);
    });

    it("handles evaluation failure gracefully with conservative defaults", async () => {
      launcher.enqueueFailure("Claude session error");

      const taskResult: TaskResult = {
        result: "success",
        summary: "Task completed",
        progressEntry: "Done",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };

      const outcome = await subconscious.evaluateOutcome(
        { taskId: "task-3", description: "Do something" },
        taskResult
      );

      expect(outcome.outcomeMatchesIntent).toBe(false);
      expect(outcome.qualityScore).toBe(0);
      expect(outcome.issuesFound.length).toBeGreaterThan(0);
      expect(outcome.issuesFound[0]).toContain("Evaluation failed");
      expect(outcome.needsReassessment).toBe(true);
    });

    it("handles malformed JSON response with conservative defaults", async () => {
      launcher.enqueueSuccess("not valid json at all");

      const taskResult: TaskResult = {
        result: "success",
        summary: "Task completed",
        progressEntry: "Done",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };

      const outcome = await subconscious.evaluateOutcome(
        { taskId: "task-4", description: "Do something" },
        taskResult
      );

      expect(outcome.outcomeMatchesIntent).toBe(false);
      expect(outcome.qualityScore).toBe(0);
      expect(outcome.issuesFound.length).toBeGreaterThan(0);
      expect(outcome.needsReassessment).toBe(true);
    });

    it("correctly parses evaluation with multiple issues and actions", async () => {
      const evaluation = JSON.stringify({
        outcomeMatchesIntent: true,
        qualityScore: 75,
        issuesFound: [
          "Performance could be optimized",
          "Error handling is basic",
          "No logging added",
        ],
        recommendedActions: [
          "Add performance benchmarks",
          "Improve error messages",
          "Add debug logging",
          "Document edge cases",
        ],
        needsReassessment: false,
      });
      launcher.enqueueSuccess(evaluation);

      const taskResult: TaskResult = {
        result: "success",
        summary: "Feature implemented",
        progressEntry: "Functional but could use refinement",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };

      const outcome = await subconscious.evaluateOutcome(
        { taskId: "task-5", description: "Implement complex feature" },
        taskResult
      );

      expect(outcome.outcomeMatchesIntent).toBe(true);
      expect(outcome.qualityScore).toBe(75);
      expect(outcome.issuesFound).toHaveLength(3);
      expect(outcome.recommendedActions).toHaveLength(4);
      expect(outcome.needsReassessment).toBe(false);
    });

    it("includes task context in evaluation prompt", async () => {
      const evaluation = JSON.stringify({
        outcomeMatchesIntent: true,
        qualityScore: 90,
        issuesFound: [],
        recommendedActions: [],
        needsReassessment: false,
      });
      launcher.enqueueSuccess(evaluation);

      const taskResult: TaskResult = {
        result: "success",
        summary: "Database migration completed",
        progressEntry: "All tables migrated successfully",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };

      await subconscious.evaluateOutcome(
        { taskId: "task-db-1", description: "Migrate user table to new schema" },
        taskResult
      );

      const launches = launcher.getLaunches();
      expect(launches.length).toBe(1);
      expect(launches[0].request.message).toContain("task-db-1");
      expect(launches[0].request.message).toContain("Migrate user table to new schema");
      expect(launches[0].request.message).toContain("Database migration completed");
    });

    it("defaults missing fields to safe values", async () => {
      // Simulate incomplete JSON response
      const evaluation = JSON.stringify({
        qualityScore: 80,
        // Missing other fields
      });
      launcher.enqueueSuccess(evaluation);

      const taskResult: TaskResult = {
        result: "success",
        summary: "Done",
        progressEntry: "Finished",
        skillUpdates: null,
        memoryUpdates: null,
        proposals: [],
      };

      const outcome = await subconscious.evaluateOutcome(
        { taskId: "task-6", description: "Do task" },
        taskResult
      );

      expect(outcome.outcomeMatchesIntent).toBe(false); // Conservative default
      expect(outcome.qualityScore).toBe(80); // Provided value
      expect(outcome.issuesFound).toEqual([]); // Default empty array
      expect(outcome.recommendedActions).toEqual([]); // Default empty array
      expect(outcome.needsReassessment).toBe(false); // Conservative default
    });
  });
});
