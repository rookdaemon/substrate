import { Subconscious } from "../../../src/agents/roles/Subconscious";
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
import { asStreamJson } from "../../helpers/streamJson";

describe("Subconscious agent", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let runner: InMemoryProcessRunner;
  let subconscious: Subconscious;

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

  describe("execute", () => {
    it("sends task to Claude and parses TaskResult", async () => {
      const claudeResponse = JSON.stringify({
        result: "success",
        summary: "Implemented the feature",
        progressEntry: "Completed task A implementation",
        skillUpdates: null,
        proposals: [],
      });
      runner.enqueue({ stdout: asStreamJson(claudeResponse), stderr: "", exitCode: 0 });

      const result = await subconscious.execute({
        taskId: "task-1",
        description: "Implement task A",
      });

      expect(result.result).toBe("success");
      expect(result.summary).toBe("Implemented the feature");
    });

    it("passes substratePath as cwd to session launcher", async () => {
      runner.enqueue({ stdout: asStreamJson(JSON.stringify({
        result: "success", summary: "Done", progressEntry: "", skillUpdates: null, proposals: [],
      })), stderr: "", exitCode: 0 });

      await subconscious.execute({ taskId: "task-1", description: "Do it" });

      const calls = runner.getCalls();
      expect(calls[0].options?.cwd).toBe("/workspace");
    });

    it("returns failure result with stderr when Claude fails", async () => {
      runner.enqueue({ stdout: "", stderr: "claude: model not found", exitCode: 1 });

      const result = await subconscious.execute({
        taskId: "task-1",
        description: "Implement task A",
      });

      expect(result.result).toBe("failure");
      expect(result.summary).toContain("claude: model not found");
    });

    it("returns failure result with error message on parse error", async () => {
      runner.enqueue({ stdout: asStreamJson("not valid json"), stderr: "", exitCode: 0 });

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
      runner.enqueue({ stdout: asStreamJson(claudeResponse), stderr: "", exitCode: 0 });

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
});
