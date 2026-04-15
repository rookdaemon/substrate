import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { SubstrateFileWriter } from "../../substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../substrate/io/AppendOnlyWriter";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ISessionLauncher, ProcessLogEntry } from "../claude/ISessionLauncher";
import { extractJson } from "../parsers/extractJson";
import { PlanParser } from "../parsers/PlanParser";
import { AgentRole } from "../types";
import { TaskClassifier } from "../TaskClassifier";
import { SuperegoFindingTracker, Finding } from "./SuperegoFindingTracker";
import { RateLimitError } from "../../loop/RateLimitError";
import { isRateLimitText } from "../../loop/rateLimitParser";
import { detectAuthorityInversion } from "../parsers/AuthorityInversionDetector";
import { ILogger } from "../../logging";

export type { Finding };

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

/** Governed domains whose proposals require Superego approval. */
const GOVERNED_DOMAINS = new Set(["HABITS", "SECURITY", "PLAN"]);

/**
 * Patterns that indicate an INVISIBLE-OUTPUT BYPASS attempt:
 * proposals claiming "internal reasoning", "no file modifications", or
 * "cognitive-only" scope to argue the governance gate does not apply.
 */
const SCOPE_BYPASS_PATTERNS = [
  /internal\s+(cognitive\s+model|reasoning(\s+task)?)/i,
  /no\s+file\s+modifications?/i,
  /cognitive[\s-]only/i,
  /no\s+auditable\s+output/i,
];

function detectsScopeBypass(proposal: Proposal): boolean {
  const text = `${proposal.target} ${proposal.content}`;
  return SCOPE_BYPASS_PATTERNS.some((pattern) => pattern.test(text));
}

const NOOP_LOGGER: ILogger = {
  debug: () => {},
  warn: () => {},
  error: () => {},
  verbose: () => {},
};

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
    private readonly workingDirectory?: string,
    private readonly logger: ILogger = NOOP_LOGGER
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
      
      let message = this.promptBuilder.buildAgentMessage(
        eagerRefs,
        lazyRefs,
        `Perform a full audit of all substrate files. Report findings.`
      );
      
      const model = this.taskClassifier.getModel({ role: AgentRole.SUPEREGO, operation: "audit" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, { model, onLogEntry, cwd: this.workingDirectory, continueSession: true, persistSession: true });

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
    // Pre-filter: SCOPE_BYPASS_ATTEMPT — governance scope is determined by
    // domain/target, not by whether work produces a file modification.
    const preRejected = new Map<number, ProposalEvaluation>();
    for (let i = 0; i < proposals.length; i++) {
      const proposal = proposals[i];
      const isGoverned = GOVERNED_DOMAINS.has(proposal.target.toUpperCase());
      if (isGoverned && detectsScopeBypass(proposal)) {
        preRejected.set(i, {
          approved: false,
          reason:
            'SCOPE_BYPASS_ATTEMPT: governance scope is determined by domain/target, not by output type. ' +
            'Proposals claiming "internal reasoning," "no file modifications," or "cognitive-only" scope ' +
            'are evaluated on the same criteria as all other proposals.',
        });
      }
    }

    // Pre-filter: AUTHORITY_INVERSION — subtractive or reference-replacing PLAN proposals
    // are rejected without reaching LLM evaluation so the rejection is logged consistently
    // and ProgressRejectionReader can pick it up.
    for (let i = 0; i < proposals.length; i++) {
      if (preRejected.has(i)) continue;
      const proposal = proposals[i];
      const detection = detectAuthorityInversion(proposal);
      if (detection.inverted) {
        preRejected.set(i, {
          approved: false,
          reason: detection.reason!,
        });
      }
    }

    // Collect indices that still need Claude evaluation
    const pendingIndices = proposals.map((_, i) => i).filter((i) => !preRejected.has(i));

    if (pendingIndices.length === 0) {
      return proposals.map((_, i) => preRejected.get(i)!);
    }

    const pendingProposals = pendingIndices.map((i) => proposals[i]);

    try {
      const systemPrompt = this.promptBuilder.buildSystemPrompt(AgentRole.SUPEREGO);
      const eagerRefs = await this.promptBuilder.getEagerReferences(AgentRole.SUPEREGO);
      const lazyRefs = this.promptBuilder.getLazyReferences(AgentRole.SUPEREGO);
      
      let message = this.promptBuilder.buildAgentMessage(
        eagerRefs,
        lazyRefs,
        `Evaluate these proposals:\n${JSON.stringify(pendingProposals, null, 2)}`
      );
      
      const model = this.taskClassifier.getModel({ role: AgentRole.SUPEREGO, operation: "evaluateProposals" });
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message,
      }, { model, onLogEntry, cwd: this.workingDirectory, continueSession: true, persistSession: true });

      let claudeEvaluations: ProposalEvaluation[];
      if (!result.success) {
        if (isRateLimitText(result.error)) throw new RateLimitError(result.error!);
        claudeEvaluations = pendingProposals.map(() => ({
          approved: false,
          reason: `Evaluation failed: ${result.error || "Claude session error"}`,
        }));
      } else {
        const parsed = extractJson(result.rawOutput);
        const evaluations: ProposalEvaluation[] = (parsed.proposalEvaluations as ProposalEvaluation[] | undefined) ?? [];

        if (evaluations.length < pendingProposals.length) {
          this.logger.warn(
            `Superego response length mismatch: expected ${pendingProposals.length} evaluations, ` +
            `received ${evaluations.length}. ` +
            `${pendingProposals.length - evaluations.length} proposals defaulting to rejection.`
          );
          while (evaluations.length < pendingProposals.length) {
            evaluations.push({ approved: false, reason: "No evaluation returned" });
          }
        }

        claudeEvaluations = evaluations;
      }

      return proposals.map((_, i) => {
        if (preRejected.has(i)) return preRejected.get(i)!;
        const pendingPos = pendingIndices.indexOf(i);
        return claudeEvaluations[pendingPos] ?? { approved: false, reason: "No evaluation returned" };
      });
    } catch (err) {
      if (err instanceof RateLimitError) throw err;
      const msg = err instanceof Error ? err.message : String(err);
      return proposals.map((_, i) => {
        if (preRejected.has(i)) return preRejected.get(i)!;
        return { approved: false, reason: `Evaluation failed: ${msg}` };
      });
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
      PLAN: SubstrateFileType.PLAN,
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
          const existing = await this.reader.read(fileType)
            .then((r) => r.rawMarkdown)
            .catch((err: unknown) => {
              const msg = err instanceof Error ? err.message : String(err);
              if (msg.includes("ENOENT")) return "";
              throw err;
            });
          let merged: string;
          if (fileType === SubstrateFileType.PLAN) {
            merged = PlanParser.appendTasksToExistingPlan(existing, [proposal.content]);
          } else {
            merged = existing
              ? `${existing.trimEnd()}\n\n---\n\n${proposal.content}`
              : proposal.content;
          }
          await this.writer.write(fileType, merged);
        } else {
          await this.logAudit(`Proposal for ${proposal.target} approved but no target handler — dropped`);
        }
      } else {
        await this.logAudit(`Proposal for ${proposal.target} rejected: ${evaluation.reason}`);
      }
    }
  }

  /**
   * Process findings to detect and escalate recurring issues.
   * CRITICAL findings escalate after 3 consecutive occurrences (CONSECUTIVE_THRESHOLD).
   * WARNING findings escalate after 5 consecutive occurrences (WARNING_THRESHOLD).
   * INFO and other severities pass through unchanged.
   * Returns filtered list of findings (excluding escalated ones).
   */
  private async processFindings(
    findings: Finding[],
    cycleNumber: number,
    tracker: SuperegoFindingTracker
  ): Promise<Finding[]> {
    const nonEscalatedFindings: Finding[] = [];

    for (const finding of findings) {
      // Track CRITICAL and WARNING findings for escalation; pass INFO through unchanged
      if (finding.severity !== "critical" && finding.severity !== "warning") {
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
