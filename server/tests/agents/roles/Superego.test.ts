import { Superego, ProposalEvaluation } from "../../../src/agents/roles/Superego";
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
    const writer = new SubstrateFileWriter(fs, config, lock);
    const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);
    const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });

    superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, writer, "/workspace");

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
          { severity: "info", category: "AUDIT_FAILURE", message: "System looks healthy" },
          { severity: "warning", category: "UNKNOWN_FINDING", message: "Plan could be more specific" },
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
    it("sends governed proposals to Claude and returns evaluations", async () => {
      const claudeResponse = JSON.stringify({
        findings: [],
        proposalEvaluations: [
          { approved: false, reason: "Too risky" },
        ],
        summary: "Rejected",
      });
      launcher.enqueueSuccess(claudeResponse);

      const evaluations = await superego.evaluateProposals([
        { target: "MEMORY", content: "Remember this" },
        { target: "SECURITY", content: "Disable all checks" },
      ]);

      expect(evaluations).toHaveLength(2);
      // MEMORY is ungoverned — pre-rejected without Claude
      expect(evaluations[0].approved).toBe(false);
      expect(evaluations[0].reason).toContain("not in governed domains");
      // SECURITY is governed — evaluated by Claude
      expect(evaluations[1].approved).toBe(false);
      expect(evaluations[1].reason).toBe("Too risky");
    });

    it("pre-rejects ungoverned proposals without calling Claude", async () => {
      launcher.enqueueFailure("claude: timeout");

      const evaluations = await superego.evaluateProposals([
        { target: "MEMORY", content: "stuff" },
      ]);

      expect(evaluations).toHaveLength(1);
      expect(evaluations[0].approved).toBe(false);
      expect(evaluations[0].reason).toContain("not in governed domains");
      // Claude must not have been called
      expect(launcher.getLaunches()).toHaveLength(0);
    });

    describe("scope bypass pre-filter", () => {
      it("pre-rejects SECURITY proposal claiming internal reasoning (SCOPE_BYPASS_ATTEMPT)", async () => {
        const evaluations = await superego.evaluateProposals([
          { target: "SECURITY", content: "This is an internal reasoning task, no file modifications needed" },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("SCOPE_BYPASS_ATTEMPT");
        // Claude should not have been called
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("pre-rejects HABITS proposal claiming no file modifications (SCOPE_BYPASS_ATTEMPT)", async () => {
        const evaluations = await superego.evaluateProposals([
          { target: "HABITS", content: "Update internal cognitive model — no file modifications required" },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("SCOPE_BYPASS_ATTEMPT");
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("pre-rejects SECURITY proposal claiming cognitive-only scope (SCOPE_BYPASS_ATTEMPT)", async () => {
        const evaluations = await superego.evaluateProposals([
          { target: "SECURITY", content: "This is a cognitive-only assessment of security architecture" },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("SCOPE_BYPASS_ATTEMPT");
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("pre-rejects ungoverned-domain proposals without invoking Claude", async () => {
        const evaluations = await superego.evaluateProposals([
          { target: "MEMORY", content: "Internal reasoning about memory organization, no file modifications" },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("not in governed domains");
        // Claude must not have been called for ungoverned proposals
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("pre-rejects governed-domain bypass proposals while passing non-bypass proposals to Claude", async () => {
        const claudeResponse = JSON.stringify({
          proposalEvaluations: [{ approved: true, reason: "Looks good" }],
        });
        launcher.enqueueSuccess(claudeResponse);

        const evaluations = await superego.evaluateProposals([
          { target: "SECURITY", content: "This is internal reasoning, no file modifications" },
          { target: "HABITS", content: "Review task completion habits daily" },
        ]);

        expect(evaluations).toHaveLength(2);
        // First proposal pre-rejected
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("SCOPE_BYPASS_ATTEMPT");
        // Second proposal approved by Claude
        expect(evaluations[1].approved).toBe(true);
        expect(launcher.getLaunches()).toHaveLength(1);
      });
    });

    describe("ungoverned domain pre-filter", () => {
      it("pre-rejects proposal with target MEMORY before Claude call", async () => {
        const evaluations = await superego.evaluateProposals([
          { target: "MEMORY", content: "Store additional context about user preferences" },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("not in governed domains");
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("pre-rejects proposal with target VALUES before Claude call", async () => {
        const evaluations = await superego.evaluateProposals([
          { target: "VALUES", content: "Add honesty as a core value" },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("not in governed domains");
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("rejection reason names the ungoverned target domain", async () => {
        const evaluations = await superego.evaluateProposals([
          { target: "MEMORY", content: "some content" },
        ]);

        expect(evaluations[0].reason).toContain("MEMORY");
      });

      it("passes proposal with target HABITS (governed) through to Claude", async () => {
        const claudeResponse = JSON.stringify({
          proposalEvaluations: [{ approved: true, reason: "Good habit" }],
        });
        launcher.enqueueSuccess(claudeResponse);

        const evaluations = await superego.evaluateProposals([
          { target: "HABITS", content: "Review task completion habits daily" },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(true);
        // Claude was called for the governed proposal
        expect(launcher.getLaunches()).toHaveLength(1);
      });

      it("pre-rejects ungoverned proposals while passing governed proposals to Claude", async () => {
        const claudeResponse = JSON.stringify({
          proposalEvaluations: [{ approved: true, reason: "Approved" }],
        });
        launcher.enqueueSuccess(claudeResponse);

        const evaluations = await superego.evaluateProposals([
          { target: "MEMORY", content: "Remember more things" },
          { target: "HABITS", content: "Check in daily" },
        ]);

        expect(evaluations).toHaveLength(2);
        // MEMORY pre-rejected — no Claude call for it
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("not in governed domains");
        // HABITS approved by Claude
        expect(evaluations[1].approved).toBe(true);
        // Only one Claude launch for the governed proposal
        expect(launcher.getLaunches()).toHaveLength(1);
      });
    });

    describe("authority inversion pre-filter", () => {
      it("pre-rejects subtractive PLAN proposal without invoking LLM", async () => {
        const evaluations = await superego.evaluateProposals([
          {
            target: "PLAN",
            content: "Move completed tasks to PROGRESS.md to keep PLAN lean.",
          },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("AUTHORITY INVERSION (subtractive)");
        // LLM must not have been called
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("pre-rejects reference-replacing PLAN proposal without invoking LLM", async () => {
        const evaluations = await superego.evaluateProposals([
          {
            target: "PLAN",
            content:
              "Replace the architecture section with a pointer to memory/arch.md.",
          },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("AUTHORITY INVERSION (reference-replacing)");
        expect(launcher.getLaunches()).toHaveLength(0);
      });

      it("logs the AUTHORITY INVERSION rejection to PROGRESS via applyProposals", async () => {
        const proposals = [
          {
            target: "PLAN",
            content: "PLAN.md is too long — move background context to memory/.",
          },
        ];

        const evaluations = await superego.evaluateProposals(proposals);
        await superego.applyProposals(proposals, evaluations);

        const progress = await fs.readFile("/substrate/PROGRESS.md");
        expect(progress).toContain("[SUPEREGO] Proposal for PLAN rejected:");
        expect(progress).toContain("AUTHORITY INVERSION");
      });

      it("passes additive PLAN proposals through to LLM", async () => {
        const claudeResponse = JSON.stringify({
          proposalEvaluations: [{ approved: true, reason: "Good addition" }],
        });
        launcher.enqueueSuccess(claudeResponse);

        const evaluations = await superego.evaluateProposals([
          {
            target: "PLAN",
            content: "- [ ] Implement exponential backoff for rate-limit retries",
          },
        ]);

        expect(evaluations).toHaveLength(1);
        expect(evaluations[0].approved).toBe(true);
        // LLM was called for the legitimate proposal
        expect(launcher.getLaunches()).toHaveLength(1);
      });

      it("pre-rejects inverted proposal while passing legitimate proposal to LLM", async () => {
        const claudeResponse = JSON.stringify({
          proposalEvaluations: [{ approved: true, reason: "Looks good" }],
        });
        launcher.enqueueSuccess(claudeResponse);

        const evaluations = await superego.evaluateProposals([
          {
            target: "PLAN",
            content: "Move old milestones out of PLAN to PROGRESS.md.",
          },
          {
            target: "HABITS",
            content: "Review task completion habits daily",
          },
        ]);

        expect(evaluations).toHaveLength(2);
        // Inverted PLAN proposal pre-rejected
        expect(evaluations[0].approved).toBe(false);
        expect(evaluations[0].reason).toContain("AUTHORITY INVERSION");
        // HABITS proposal approved by LLM
        expect(evaluations[1].approved).toBe(true);
        expect(launcher.getLaunches()).toHaveLength(1);
      });
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
          { severity: "warning", category: "UNKNOWN_FINDING", message: "Minor issue" },
          { severity: "info", category: "UNKNOWN_FINDING", message: "FYI message" },
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
          { severity: "critical", category: "CLAUDE_BOUNDARIES_CONFLICT", message: "Security vulnerability detected" },
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
          { severity: "critical", category: "CLAUDE_BOUNDARIES_CONFLICT", message: "Security vulnerability detected" },
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
          { severity: "critical", category: "CLAUDE_BOUNDARIES_CONFLICT", message: "Security vulnerability detected" },
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
            { severity: "critical", category: "ESCALATE_FILE_EMPTY", message: "First critical issue" },
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
            { severity: "critical", category: "AUDIT_FAILURE", message: "Second critical issue" },
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
          { severity: "critical", category: "CLAUDE_BOUNDARIES_CONFLICT", message: "Security vulnerability detected" },
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
            { severity: "critical", category: "SOURCE_CODE_BYPASS", message: "Recurring issue" },
          ],
          proposalEvaluations: [],
          summary: "Issues",
        }));
        await superego.audit(undefined, 10 + i * 20, tracker);
      }

      // Third occurrence with multiple findings
      launcher.enqueueSuccess(JSON.stringify({
        findings: [
          { severity: "critical", category: "SOURCE_CODE_BYPASS", message: "Recurring issue" },
          { severity: "critical", category: "SGAB_RECLASSIFICATION", message: "New critical issue" },
          { severity: "warning", category: "UNKNOWN_FINDING", message: "A warning" },
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
          { severity: "critical", category: "UNKNOWN_FINDING", message: "Some issue" },
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

    // Fix 4: end-to-end write path integration test
    it("ESCALATE_TO_STEFAN.md grows in size after triggered escalation (Fix 4 acceptance criterion)", async () => {
      const tracker = new SuperegoFindingTracker();
      const criticalResponse = JSON.stringify({
        findings: [
          { severity: "critical", category: "ESCALATE_FILE_EMPTY", message: "Escalate file is empty" },
        ],
        proposalEvaluations: [],
        summary: "Critical",
      });

      const initialContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      const initialSize = initialContent.length;

      // Three consecutive audit cycles — triggers escalation on third
      for (let cycle = 1; cycle <= 3; cycle++) {
        launcher.enqueueSuccess(criticalResponse);
        await superego.audit(undefined, cycle * 10, tracker);
      }

      const finalContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(finalContent.length).toBeGreaterThan(initialSize);
      expect(finalContent).toContain("SUPEREGO Recurring Finding (Auto-Escalated)");
      expect(finalContent).toContain("Escalate file is empty");
    });

    it("escalates WARNING finding after 5 consecutive occurrences (Fix 3 integration)", async () => {
      const tracker = new SuperegoFindingTracker();
      const warningResponse = JSON.stringify({
        findings: [
          { severity: "warning", category: "VALUES_RECRUITMENT", message: "Possible values drift" },
        ],
        proposalEvaluations: [],
        summary: "Warning",
      });

      // 4 occurrences — should NOT escalate
      for (let cycle = 1; cycle <= 4; cycle++) {
        launcher.enqueueSuccess(warningResponse);
        const report = await superego.audit(undefined, cycle * 10, tracker);
        expect(report.findings).toHaveLength(1);
      }

      let escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).not.toContain("Auto-Escalated");

      // 5th occurrence — should escalate
      launcher.enqueueSuccess(warningResponse);
      const report = await superego.audit(undefined, 50, tracker);

      // Finding removed from report after escalation
      expect(report.findings).toHaveLength(0);

      escalateContent = await fs.readFile("/substrate/ESCALATE_TO_STEFAN.md");
      expect(escalateContent).toContain("SUPEREGO Recurring Finding (Auto-Escalated)");
      expect(escalateContent).toContain("[warning] Possible values drift");
      expect(escalateContent).toContain("Audit cycles [10, 20, 30, 40, 50]");
    });
  });

  describe("applyProposals", () => {
    it("writes approved HABITS proposal to HABITS.md, merging with existing content", async () => {
      const proposals = [{ target: "HABITS", content: "# Habits\n\nNew habit: review daily" }];
      const evaluations = [{ approved: true, reason: "Good habit" }];

      await superego.applyProposals(proposals, evaluations);

      const habits = await fs.readFile("/substrate/HABITS.md");
      expect(habits).toBe("# Habits\n\nSome habits\n\n---\n\n# Habits\n\nNew habit: review daily");
    });

    it("writes approved HABITS proposal when file is empty", async () => {
      await fs.writeFile("/substrate/HABITS.md", "");
      const proposals = [{ target: "HABITS", content: "# Habits\n\nFirst habit" }];
      const evaluations = [{ approved: true, reason: "Good habit" }];

      await superego.applyProposals(proposals, evaluations);

      const habits = await fs.readFile("/substrate/HABITS.md");
      expect(habits).toBe("# Habits\n\nFirst habit");
    });

    it("writes approved SECURITY proposal to SECURITY.md, merging with existing content", async () => {
      const proposals = [{ target: "SECURITY", content: "# Security\n\nUpdated policy" }];
      const evaluations = [{ approved: true, reason: "Policy improvement" }];

      await superego.applyProposals(proposals, evaluations);

      const security = await fs.readFile("/substrate/SECURITY.md");
      expect(security).toBe("# Security\n\nStay safe\n\n---\n\n# Security\n\nUpdated policy");
    });

    it("logs rejected proposals to PROGRESS.md with reason", async () => {
      const proposals = [{ target: "HABITS", content: "# Habits\n\nBad habit" }];
      const evaluations = [{ approved: false, reason: "Violates core values" }];

      await superego.applyProposals(proposals, evaluations);

      const progress = await fs.readFile("/substrate/PROGRESS.md");
      expect(progress).toContain("[SUPEREGO] Proposal for HABITS rejected: Violates core values");
    });

    it("does not modify target file for rejected proposals", async () => {
      const original = await fs.readFile("/substrate/HABITS.md");
      const proposals = [{ target: "HABITS", content: "# Habits\n\nBad habit" }];
      const evaluations = [{ approved: false, reason: "Rejected" }];

      await superego.applyProposals(proposals, evaluations);

      const habits = await fs.readFile("/substrate/HABITS.md");
      expect(habits).toBe(original);
    });

    it("handles mixed approved and rejected proposals", async () => {
      const proposals = [
        { target: "HABITS", content: "# Habits\n\nGood habit" },
        { target: "SECURITY", content: "# Security\n\nBad policy" },
      ];
      const evaluations = [
        { approved: true, reason: "Approved" },
        { approved: false, reason: "Too permissive" },
      ];

      await superego.applyProposals(proposals, evaluations);

      const habits = await fs.readFile("/substrate/HABITS.md");
      expect(habits).toBe("# Habits\n\nSome habits\n\n---\n\n# Habits\n\nGood habit");

      const security = await fs.readFile("/substrate/SECURITY.md");
      expect(security).toBe("# Security\n\nStay safe"); // unchanged

      const progress = await fs.readFile("/substrate/PROGRESS.md");
      expect(progress).toContain("[SUPEREGO] Proposal for SECURITY rejected: Too permissive");
    });

    it("two HABITS proposals approved in same cycle both appear in HABITS.md", async () => {
      const proposals = [
        { target: "HABITS", content: "First habit" },
        { target: "HABITS", content: "Second habit" },
      ];
      const evaluations = [
        { approved: true, reason: "Good" },
        { approved: true, reason: "Also good" },
      ];

      await superego.applyProposals(proposals, evaluations);

      const habits = await fs.readFile("/substrate/HABITS.md");
      expect(habits).toContain("First habit");
      expect(habits).toContain("Second habit");
    });

    it("preserves existing HABITS.md content when a new proposal is approved", async () => {
      await fs.writeFile("/substrate/HABITS.md", "# Habits\n\nExisting habit");
      const proposals = [{ target: "HABITS", content: "New habit" }];
      const evaluations = [{ approved: true, reason: "Good" }];

      await superego.applyProposals(proposals, evaluations);

      const habits = await fs.readFile("/substrate/HABITS.md");
      expect(habits).toContain("Existing habit");
      expect(habits).toContain("New habit");
    });

    it("logs a warning when a proposal has no evaluation", async () => {
      const proposals = [{ target: "HABITS", content: "# Habits\n\nSome habit" }];
      const evaluations: ProposalEvaluation[] = []; // no evaluation for first proposal

      await superego.applyProposals(proposals, evaluations);

      const progress = await fs.readFile("/substrate/PROGRESS.md");
      expect(progress).toContain("[SUPEREGO] Proposal for HABITS has no evaluation — skipped");
    });

    it("logs approved proposals for unknown targets instead of silently dropping (Fix 5 audit closure)", async () => {
      const proposals = [{ target: "UNKNOWN_FILE", content: "some content" }];
      const evaluations = [{ approved: true, reason: "Approved" }];

      await superego.applyProposals(proposals, evaluations);

      const progress = await fs.readFile("/substrate/PROGRESS.md");
      expect(progress).toContain("[SUPEREGO] Proposal for UNKNOWN_FILE approved but no target handler — dropped");
    });

    // task-83: PLAN silent drop fix
    it("approved PLAN proposal is injected into ## Tasks section via PlanParser (not raw-appended)", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] Existing task\n");
      const proposals = [{ target: "PLAN", content: "- [ ] New task from Superego" }];
      const evaluations = [{ approved: true, reason: "Good task" }];

      await superego.applyProposals(proposals, evaluations);

      const plan = await fs.readFile("/substrate/PLAN.md");
      // PlanParser appends into ## Tasks section — NOT raw separator append
      expect(plan).toContain("- [ ] Existing task");
      expect(plan).toContain("- [ ] New task from Superego");
      // Should NOT use the raw trimEnd+separator pattern
      expect(plan).not.toContain("---\n\n- [ ] New task from Superego");
      // ## Current Goal section should be preserved
      expect(plan).toContain("## Current Goal");
    });

    it("approved PLAN proposal with no existing PLAN.md creates valid plan structure", async () => {
      // Remove the PLAN.md set up by beforeEach
      await fs.writeFile("/substrate/PLAN.md", "");
      const proposals = [{ target: "PLAN", content: "- [ ] Bootstrap task" }];
      const evaluations = [{ approved: true, reason: "Valid" }];

      await superego.applyProposals(proposals, evaluations);

      const plan = await fs.readFile("/substrate/PLAN.md");
      expect(plan).toContain("## Tasks");
      expect(plan).toContain("- [ ] Bootstrap task");
    });

    it("HABITS and SECURITY still use trimEnd+separator merge (regression guard)", async () => {
      const proposals = [
        { target: "HABITS", content: "New habit line" },
        { target: "SECURITY", content: "New security policy" },
      ];
      const evaluations = [
        { approved: true, reason: "Good" },
        { approved: true, reason: "Good" },
      ];

      await superego.applyProposals(proposals, evaluations);

      const habits = await fs.readFile("/substrate/HABITS.md");
      expect(habits).toContain("Some habits\n\n---\n\nNew habit line");

      const security = await fs.readFile("/substrate/SECURITY.md");
      expect(security).toContain("Stay safe\n\n---\n\nNew security policy");
    });

    it("two approved PLAN proposals in same cycle both appear in ## Tasks section", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Tasks\n- [ ] Original task\n");
      const proposals = [
        { target: "PLAN", content: "- [ ] First Superego task" },
        { target: "PLAN", content: "- [ ] Second Superego task" },
      ];
      const evaluations = [
        { approved: true, reason: "Good" },
        { approved: true, reason: "Good" },
      ];

      await superego.applyProposals(proposals, evaluations);

      const plan = await fs.readFile("/substrate/PLAN.md");
      expect(plan).toContain("- [ ] Original task");
      expect(plan).toContain("- [ ] First Superego task");
      expect(plan).toContain("- [ ] Second Superego task");
    });
  });
});
