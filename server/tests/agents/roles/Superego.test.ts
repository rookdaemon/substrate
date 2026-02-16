import { Superego } from "../../../src/agents/roles/Superego";
import { PermissionChecker } from "../../../src/agents/permissions";
import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { TaskClassifier } from "../../../src/agents/TaskClassifier";
import { SuperegoFindingTracker } from "../../../src/agents/roles/SuperegoFindingTracker";

describe("Superego agent", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let launcher: InMemorySessionLauncher;
  let superego: Superego;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
    launcher = new InMemorySessionLauncher();
    const config = new SubstrateConfig("/substrate");
    const reader = new SubstrateFileReader(fs, config);
    const lock = new FileLock();
    const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);
    const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });

    superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace");

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
    await fs.writeFile("/substrate/ESCALATE_TO_STEFAN.md", "# Escalate to Stefan\n\n---\n");
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
      launcher.enqueueSuccess(claudeResponse);

      const report = await superego.audit();
      expect(report.findings).toHaveLength(2);
      expect(report.findings[0].severity).toBe("info");
      expect(report.summary).toBe("Overall good shape");
    });

    it("passes substratePath as cwd to session launcher", async () => {
      launcher.enqueueSuccess(JSON.stringify({
        findings: [], proposalEvaluations: [], summary: "OK",
      }));

      await superego.audit();

      const launches = launcher.getLaunches();
      expect(launches[0].options?.cwd).toBe("/workspace");
    });

    it("returns error report with stderr when Claude fails", async () => {
      launcher.enqueueFailure("claude: connection refused");

      const report = await superego.audit();
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe("critical");
      expect(report.findings[0].message).toContain("claude: connection refused");
    });

    it("returns error report with error message on parse error", async () => {
      launcher.enqueueSuccess("not json");

      const report = await superego.audit();
      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe("critical");
      expect(report.findings[0].message).toMatch(/JSON|Unexpected|parse/i);
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
      launcher.enqueueSuccess(claudeResponse);

      const evaluations = await superego.evaluateProposals([
        { target: "MEMORY", content: "Remember this" },
        { target: "SECURITY", content: "Disable all checks" },
      ]);

      expect(evaluations).toHaveLength(2);
      expect(evaluations[0].approved).toBe(true);
      expect(evaluations[1].approved).toBe(false);
    });

    it("rejects all proposals with stderr when Claude fails", async () => {
      launcher.enqueueFailure("claude: timeout");

      const evaluations = await superego.evaluateProposals([
        { target: "MEMORY", content: "stuff" },
      ]);

      expect(evaluations).toHaveLength(1);
      expect(evaluations[0].approved).toBe(false);
      expect(evaluations[0].reason).toContain("claude: timeout");
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

  describe("audit with finding tracker (escalation)", () => {
    it("does not escalate non-critical findings", async () => {
      const tracker = new SuperegoFindingTracker();
      const claudeResponse = JSON.stringify({
        findings: [
          { severity: "warning", message: "Minor issue" },
          { severity: "info", message: "FYI message" },
        ],
        proposalEvaluations: [],
        summary: "OK",
      });
      launcher.enqueueSuccess(claudeResponse);

      const report = await superego.audit(undefined, 10, tracker);

      expect(report.findings).toHaveLength(2);
      const escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).not.toContain("Auto-Escalated");
    });

    it("does not escalate critical finding on first occurrence", async () => {
      const tracker = new SuperegoFindingTracker();
      const claudeResponse = JSON.stringify({
        findings: [
          { severity: "critical", message: "Security vulnerability detected" },
        ],
        proposalEvaluations: [],
        summary: "Critical issue",
      });
      launcher.enqueueSuccess(claudeResponse);

      const report = await superego.audit(undefined, 10, tracker);

      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe("critical");
      const escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).not.toContain("Auto-Escalated");
    });

    it("does not escalate critical finding on second occurrence", async () => {
      const tracker = new SuperegoFindingTracker();
      const claudeResponse = JSON.stringify({
        findings: [
          { severity: "critical", message: "Security vulnerability detected" },
        ],
        proposalEvaluations: [],
        summary: "Critical issue",
      });

      launcher.enqueueSuccess(claudeResponse);
      await superego.audit(undefined, 10, tracker);

      launcher.enqueueSuccess(claudeResponse);
      const report = await superego.audit(undefined, 30, tracker);

      expect(report.findings).toHaveLength(1);
      const escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).not.toContain("Auto-Escalated");
    });

    it("escalates critical finding after third consecutive occurrence", async () => {
      const tracker = new SuperegoFindingTracker();
      const claudeResponse = JSON.stringify({
        findings: [
          { severity: "critical", message: "Security vulnerability detected" },
        ],
        proposalEvaluations: [],
        summary: "Critical issue",
      });

      launcher.enqueueSuccess(claudeResponse);
      await superego.audit(undefined, 10, tracker);

      launcher.enqueueSuccess(claudeResponse);
      await superego.audit(undefined, 30, tracker);

      launcher.enqueueSuccess(claudeResponse);
      const report = await superego.audit(undefined, 50, tracker);

      // Finding should be filtered from report after escalation
      expect(report.findings).toHaveLength(0);

      // Check ESCALATE_TO_STEFAN.md
      const escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).toContain("SUPEREGO Recurring Finding (Auto-Escalated)");
      expect(escalateContent).toContain("[critical] Security vulnerability detected");
      expect(escalateContent).toContain("Audit cycles [10, 30, 50]");
      expect(escalateContent).toContain("**First detected:** Cycle 10");
      expect(escalateContent).toContain("**Last occurrence:** Cycle 50");

      // Check PROGRESS.md for escalation log
      const progressContent = await fs.readFile("/substrate/PROGRESS.md");
      expect(progressContent).toContain("[SUPEREGO] ESCALATED recurring finding");
      expect(progressContent).toContain("Security vulnerability detected");
    });

    it("escalates multiple different critical findings independently", async () => {
      const tracker = new SuperegoFindingTracker();

      // First finding appears 3 times
      for (let i = 0; i < 3; i++) {
        launcher.enqueueSuccess(JSON.stringify({
          findings: [
            { severity: "critical", message: "First critical issue" },
          ],
          proposalEvaluations: [],
          summary: "Issue 1",
        }));
        await superego.audit(undefined, 10 + i * 20, tracker);
      }

      // Second finding appears 3 times
      for (let i = 0; i < 3; i++) {
        launcher.enqueueSuccess(JSON.stringify({
          findings: [
            { severity: "critical", message: "Second critical issue" },
          ],
          proposalEvaluations: [],
          summary: "Issue 2",
        }));
        await superego.audit(undefined, 100 + i * 20, tracker);
      }

      const escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).toContain("First critical issue");
      expect(escalateContent).toContain("Second critical issue");
      expect(escalateContent).toContain("Audit cycles [10, 30, 50]");
      expect(escalateContent).toContain("Audit cycles [100, 120, 140]");
    });

    it("does not re-escalate finding after clearing from tracker", async () => {
      const tracker = new SuperegoFindingTracker();
      const claudeResponse = JSON.stringify({
        findings: [
          { severity: "critical", message: "Security vulnerability detected" },
        ],
        proposalEvaluations: [],
        summary: "Critical issue",
      });

      // Trigger escalation
      launcher.enqueueSuccess(claudeResponse);
      await superego.audit(undefined, 10, tracker);
      launcher.enqueueSuccess(claudeResponse);
      await superego.audit(undefined, 30, tracker);
      launcher.enqueueSuccess(claudeResponse);
      await superego.audit(undefined, 50, tracker);

      // Fourth occurrence (after escalation and clearing)
      launcher.enqueueSuccess(claudeResponse);
      await superego.audit(undefined, 70, tracker);

      const escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      // Should only have one escalation entry
      const matches = escalateContent.match(/Auto-Escalated/g);
      expect(matches).toHaveLength(1);
    });

    it("maintains other findings when escalating one", async () => {
      const tracker = new SuperegoFindingTracker();
      
      // Set up a critical finding that will escalate
      for (let i = 0; i < 2; i++) {
        launcher.enqueueSuccess(JSON.stringify({
          findings: [
            { severity: "critical", message: "Recurring issue" },
          ],
          proposalEvaluations: [],
          summary: "Issues",
        }));
        await superego.audit(undefined, 10 + i * 20, tracker);
      }

      // Third occurrence with multiple findings
      launcher.enqueueSuccess(JSON.stringify({
        findings: [
          { severity: "critical", message: "Recurring issue" },
          { severity: "critical", message: "New critical issue" },
          { severity: "warning", message: "A warning" },
        ],
        proposalEvaluations: [],
        summary: "Multiple issues",
      }));
      const report = await superego.audit(undefined, 50, tracker);

      // Recurring issue should be escalated and removed
      // New critical and warning should remain
      expect(report.findings).toHaveLength(2);
      expect(report.findings.find((f) => f.message === "New critical issue")).toBeDefined();
      expect(report.findings.find((f) => f.message === "A warning")).toBeDefined();
      expect(report.findings.find((f) => f.message === "Recurring issue")).toBeUndefined();
    });

    it("works without tracker and cycleNumber (backward compatibility)", async () => {
      const claudeResponse = JSON.stringify({
        findings: [
          { severity: "critical", message: "Some issue" },
        ],
        proposalEvaluations: [],
        summary: "Issues",
      });
      launcher.enqueueSuccess(claudeResponse);

      // Call without tracker or cycleNumber (old way)
      const report = await superego.audit();

      expect(report.findings).toHaveLength(1);
      expect(report.findings[0].severity).toBe("critical");
      
      // No escalation should occur
      const escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).not.toContain("Auto-Escalated");
    });
  });
});
