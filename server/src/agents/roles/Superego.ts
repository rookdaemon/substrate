import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { SubstrateFileWriter } from "../../substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../substrate/io/AppendOnlyWriter";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry } from "../claude/ISessionLauncher";
import { extractJson } from "../parsers/extractJson";
import { AgentRole } from "../types";
import { TaskClassifier } from "../TaskClassifier";
import { SuperegoFindingTracker } from "./SuperegoFindingTracker";

export interface Finding {
  severity: "info" | "warning" | "critical";
  message: string;
}

export interface ProposalEvaluation {
  approved: boolean;
  reason: string;
}

export interface GovernanceReport {
  findings: Finding[];
  proposalEvaluations: ProposalEvaluation[];
  summary: string;
  [key: string]: unknown;
}

export interface Proposal {
  target: string;
  content: string;
}

export class Superego {
  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly appendWriter: AppendOnlyWriter,
    private readonly checker: PermissionChecker,
    private readonly promptBuilder: PromptBuilder,
    private readonly sessionLauncher: ISessionLauncher,
    private readonly clock: IClock,
    private readonly taskClassifier: TaskClassifier,
    private readonly writer: SubstrateFileWriter,
    private readonly workingDirectory?: string
  ) {}

  async audit(
    onLogEntry?: (entry: ProcessLogEntry) => void,
    cycleNumber?: number,
    findingTracker?: SuperegoFindingTracker
  ): Promise<GovernanceReport> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.SUPEREGO);
      const eagerRefs = await this.promptBuilder.getEagerReferences(AgentRole.SUPEREGO, {
        maxLines: {
          [SubstrateFileType.PROGRESS]: 200,
          [SubstrateFileType.CONVERSATION]: 100,
        },
      });
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.SUPEREGO);
      
      let message = "";
      if (eagerRefs) {
        message += `=== CONTEXT (auto-loaded) ===\n${eagerRefs}\n\n`;
      }
      if (lazyRefs) {
        message += `=== AVAILABLE FILES (read on demand) ===\nUse the Read tool to access any of these when needed:\n${lazyRefs}\n\n`;
      }
      message += `Perform a full audit of all substrate files. Report findings.`;
      
      const model = this.taskClassifier.getModel({ role: AgentRole.SUPEREGO, operation: "audit" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, { model, onLogEntry, cwd: this.workingDirectory });

      if (!result.success) {
        return {
          findings: [{ severity: "critical", message: `Audit failed: ${result.error || "Claude session error"}` }],
          proposalEvaluations: [],
          summary: `Audit failed: ${result.error || "session error"}`,
        };
      }

      const parsed = extractJson(result.rawOutput);
      const findings = (parsed.findings as Finding[] | undefined) ?? [];
      
      // Process findings for escalation if tracker and cycleNumber provided
      let filteredFindings = findings;
      if (findingTracker && cycleNumber !== undefined) {
        filteredFindings = await this.processFindings(findings, cycleNumber, findingTracker);
      }

      return {
        findings: filteredFindings,
        proposalEvaluations: (parsed.proposalEvaluations as ProposalEvaluation[] | undefined) ?? [],
        summary: (parsed.summary as string | undefined) ?? "",
      };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return {
        findings: [{ severity: "critical", message: `Audit failed: ${msg}` }],
        proposalEvaluations: [],
        summary: `Audit failed: ${msg}`,
      };
    }
  }

  async evaluateProposals(proposals: Proposal[], onLogEntry?: (entry: ProcessLogEntry) => void): Promise<ProposalEvaluation[]> {
    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.SUPEREGO);
      const eagerRefs = await this.promptBuilder.getEagerReferences(AgentRole.SUPEREGO);
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.SUPEREGO);
      
      let message = "";
      if (eagerRefs) {
        message += `=== CONTEXT (auto-loaded) ===\n${eagerRefs}\n\n`;
      }
      if (lazyRefs) {
        message += `=== AVAILABLE FILES (read on demand) ===\nUse the Read tool to access any of these when needed:\n${lazyRefs}\n\n`;
      }
      message += `Evaluate these proposals:\n${JSON.stringify(proposals, null, 2)}`;
      
      const model = this.taskClassifier.getModel({ role: AgentRole.SUPEREGO, operation: "evaluateProposals" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, { model, onLogEntry, cwd: this.workingDirectory });

      if (!result.success) {
        return proposals.map(() => ({
          approved: false,
          reason: `Evaluation failed: ${result.error || "Claude session error"}`,
        }));
      }

      const parsed = extractJson(result.rawOutput);
      return (parsed.proposalEvaluations as ProposalEvaluation[] | undefined) ?? proposals.map(() => ({
        approved: false,
        reason: "No evaluation returned",
      }));
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return proposals.map(() => ({
        approved: false,
        reason: `Evaluation failed: ${msg}`,
      }));
    }
  }

  async logAudit(entry: string): Promise<void> {
    this.checker.assertCanAppend(AgentRole.SUPEREGO, SubstrateFileType.PROGRESS);
    await this.appendWriter.append(SubstrateFileType.PROGRESS, `[SUPEREGO] ${entry}`);
  }

  /**
   * Apply approved proposals to their target files and log rejections to PROGRESS.md.
   * Approved proposals targeting HABITS or SECURITY are written to the respective files.
   * Rejected proposals are logged with the reason.
   */
  async applyProposals(proposals: Proposal[], evaluations: ProposalEvaluation[]): Promise<void> {
    const targetMap: Record<string, SubstrateFileType> = {
      HABITS: SubstrateFileType.HABITS,
      SECURITY: SubstrateFileType.SECURITY,
    };

    for (let i = 0; i < proposals.length; i++) {
      const proposal = proposals[i];
      const evaluation = evaluations[i];

      if (!evaluation) {
        await this.logAudit(`Proposal for ${proposal.target} has no evaluation — skipped`);
        continue;
      }

      if (evaluation.approved) {
        const fileType = targetMap[proposal.target.toUpperCase()];
        if (fileType) {
          this.checker.assertCanWrite(AgentRole.SUPEREGO, fileType);
          await this.writer.write(fileType, proposal.content);
        }
      } else {
        await this.logAudit(`Proposal for ${proposal.target} rejected: ${evaluation.reason}`);
      }
    }
  }

  /**
   * Process findings to detect and escalate recurring critical issues.
   * Returns filtered list of findings (excluding escalated ones).
   */
  private async processFindings(
    findings: Finding[],
    cycleNumber: number,
    tracker: SuperegoFindingTracker
  ): Promise<Finding[]> {
    const nonEscalatedFindings: Finding[] = [];

    for (const finding of findings) {
      // Only track CRITICAL findings for escalation
      if (finding.severity !== "critical") {
        nonEscalatedFindings.push(finding);
        continue;
      }

      // Track the finding and check if it should escalate
      const shouldEscalate = tracker.track(finding, cycleNumber);

      if (shouldEscalate) {
        const escalationInfo = tracker.getEscalationInfo(finding);
        if (escalationInfo) {
          await this.escalateFinding(escalationInfo);
          tracker.clearFinding(escalationInfo.findingId);
          // Don't include escalated finding in returned list (reduces noise)
        }
      } else {
        // Not yet escalated, include in normal findings
        nonEscalatedFindings.push(finding);
      }
    }

    return nonEscalatedFindings;
  }

  /**
   * Escalate a recurring finding to ESCALATE_TO_STEFAN.md.
   */
  private async escalateFinding(info: {
    findingId: string;
    severity: string;
    message: string;
    cycles: number[];
    firstDetectedCycle: number;
    lastOccurrenceCycle: number;
  }): Promise<void> {
    this.checker.assertCanAppend(AgentRole.SUPEREGO, SubstrateFileType.ESCALATE_TO_STEFAN);

    const timestamp = this.clock.now().toISOString();
    const escalationEntry = `
## SUPEREGO Recurring Finding (Auto-Escalated)

**Finding:** [${info.severity}] ${info.message}
**Occurrences:** Audit cycles [${info.cycles.join(", ")}]
**First detected:** Cycle ${info.firstDetectedCycle}
**Last occurrence:** Cycle ${info.lastOccurrenceCycle}
**Escalated at:** ${timestamp}
**Status:** Auto-escalated after ${info.cycles.length} consecutive audits

---
`;

    await this.appendWriter.append(SubstrateFileType.ESCALATE_TO_STEFAN, escalationEntry);
    
    // Log the escalation to PROGRESS.md
    await this.appendWriter.append(
      SubstrateFileType.PROGRESS,
      `[SUPEREGO] ESCALATED recurring finding (${info.cycles.length} occurrences): ${info.message.substring(0, 100)}...`
    );
  }
}
