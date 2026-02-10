import { Id } from "../../../src/agents/roles/Id";
import { PermissionChecker } from "../../../src/agents/permissions";
import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";

describe("Id agent", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let launcher: InMemorySessionLauncher;
  let id: Id;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
    launcher = new InMemorySessionLauncher();
    const config = new SubstrateConfig("/substrate");
    const reader = new SubstrateFileReader(fs, config);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);

    id = new Id(reader, checker, promptBuilder, launcher, clock, "/workspace");

    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] Do stuff");
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

  describe("detectIdle", () => {
    it("returns false when plan has pending tasks", async () => {
      const result = await id.detectIdle();
      expect(result.idle).toBe(false);
    });

    it("returns true when plan has no tasks", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nNothing\n\n## Tasks\n");
      const result = await id.detectIdle();
      expect(result.idle).toBe(true);
      expect(result.reason).toMatch(/empty|no tasks/i);
    });

    it("returns true when all tasks are complete", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nDone\n\n## Tasks\n- [x] Done");
      const result = await id.detectIdle();
      expect(result.idle).toBe(true);
      expect(result.reason).toMatch(/complete/i);
    });
  });

  describe("generateDrives", () => {
    it("sends context to Claude and parses GoalCandidate[] response", async () => {
      const claudeResponse = JSON.stringify({
        idle: true,
        reason: "All tasks done",
        goalCandidates: [
          { title: "Learn TypeScript", description: "Improve coding skills", priority: "high", confidence: 85 },
          { title: "Write docs", description: "Document the system", priority: "medium", confidence: 90 },
        ],
      });
      launcher.enqueueSuccess(claudeResponse);

      const drives = await id.generateDrives();
      expect(drives).toHaveLength(2);
      expect(drives[0].title).toBe("Learn TypeScript");
      expect(drives[0].priority).toBe("high");
      expect(drives[0].confidence).toBe(85);
      expect(drives[1].title).toBe("Write docs");
      expect(drives[1].confidence).toBe(90);
    });

    it("parses confidence scores correctly from response", async () => {
      const claudeResponse = JSON.stringify({
        goalCandidates: [
          { title: "High confidence goal", description: "Safe goal", priority: "high", confidence: 95 },
          { title: "Low confidence goal", description: "Risky goal", priority: "low", confidence: 45 },
        ],
      });
      launcher.enqueueSuccess(claudeResponse);

      const drives = await id.generateDrives();
      expect(drives).toHaveLength(2);
      expect(drives[0].confidence).toBe(95);
      expect(drives[1].confidence).toBe(45);
    });

    it("passes substratePath as cwd to session launcher", async () => {
      launcher.enqueueSuccess(JSON.stringify({
        goalCandidates: [{ title: "Goal", description: "Do it", priority: "high" }],
      }));

      await id.generateDrives();

      const launches = launcher.getLaunches();
      expect(launches[0].options?.cwd).toBe("/workspace");
    });

    it("returns empty array when Claude fails", async () => {
      launcher.enqueueFailure("error");

      const drives = await id.generateDrives();
      expect(drives).toEqual([]);
    });

    it("returns empty array when Claude returns invalid JSON", async () => {
      launcher.enqueueSuccess("not json at all");

      const drives = await id.generateDrives();
      expect(drives).toEqual([]);
    });
  });
});
