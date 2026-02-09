import { Superego } from "../../../src/agents/roles/Superego";
import { PermissionChecker } from "../../../src/agents/permissions";
import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../../../src/agents/claude/ClaudeSessionLauncher";
import { InMemoryProcessRunner } from "../../../src/agents/claude/InMemoryProcessRunner";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { asStreamJson } from "../../helpers/streamJson";

describe("Superego agent", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let runner: InMemoryProcessRunner;
  let superego: Superego;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
    runner = new InMemoryProcessRunner();
    const config = new SubstrateConfig("/substrate");
    const reader = new SubstrateFileReader(fs, config);
    const lock = new FileLock();
    const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);
    const launcher = new ClaudeSessionLauncher(runner, clock);

    superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock);

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

  describe("audit", () => {
    it("sends all substrate context to Claude and parses GovernanceReport", async () => {
      const claudeResponse = JSON.stringify({
        findings: [
          { severity: "info", message: "System looks healthy" },
          { severity: "warning", message: "Plan could be more specific" },
        ],
        proposalEvaluations: [],
        summary: "Overall good shape",
      });
      runner.enqueue({ stdout: asStreamJson(claudeResponse), stderr: "", exitCode: 0 });

      const report = await superego.audit();
      expect(report.findings).toHaveLength(2);
      expect(report.findings[0].severity).toBe("info");
      expect(report.summary).toBe("Overall good shape");
    });

    it("returns error report when Claude fails", async () => {
      runner.enqueue({ stdout: "", stderr: "error", exitCode: 1 });

      const report = await superego.audit();
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe("critical");
      expect(report.summary).toMatch(/failed/i);
    });
  });

  describe("evaluateProposals", () => {
    it("sends proposals to Claude and returns evaluations", async () => {
      const claudeResponse = JSON.stringify({
        findings: [],
        proposalEvaluations: [
          { approved: true, reason: "Looks good" },
          { approved: false, reason: "Too risky" },
        ],
        summary: "Mixed results",
      });
      runner.enqueue({ stdout: asStreamJson(claudeResponse), stderr: "", exitCode: 0 });

      const evaluations = await superego.evaluateProposals([
        { target: "MEMORY", content: "Remember this" },
        { target: "SECURITY", content: "Disable all checks" },
      ]);

      expect(evaluations).toHaveLength(2);
      expect(evaluations[0].approved).toBe(true);
      expect(evaluations[1].approved).toBe(false);
    });

    it("rejects all proposals when Claude fails", async () => {
      runner.enqueue({ stdout: "", stderr: "error", exitCode: 1 });

      const evaluations = await superego.evaluateProposals([
        { target: "MEMORY", content: "stuff" },
      ]);

      expect(evaluations).toHaveLength(1);
      expect(evaluations[0].approved).toBe(false);
    });
  });

  describe("logAudit", () => {
    it("appends audit entry to PROGRESS", async () => {
      await superego.logAudit("Audit complete: no issues found");

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("[2025-06-15T10:00:00.000Z]");
      expect(content).toContain("[SUPEREGO] Audit complete: no issues found");
    });
  });
});
