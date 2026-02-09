import { IClock } from "../../substrate/abstractions/IClock";
import { SubstrateFileType } from "../../substrate/types";
import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { AppendOnlyWriter } from "../../substrate/io/AppendOnlyWriter";
import { PermissionChecker } from "../permissions";
import { PromptBuilder } from "../prompts/PromptBuilder";
import { ClaudeSessionLauncher } from "../claude/ClaudeSessionLauncher";
import { ProcessLogEntry } from "../claude/StreamJsonParser";
import { AgentRole } from "../types";

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
    private readonly sessionLauncher: ClaudeSessionLauncher,
    private readonly clock: IClock,
    private readonly workingDirectory?: string
  ) {}

  async audit(onLogEntry?: (entry: ProcessLogEntry) => void): Promise<GovernanceReport> {
    try {
      const systemPrompt = await this.promptBuilder.buildSystemPrompt(AgentRole.SUPEREGO);
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: "Perform a full audit of all substrate files. Report findings.",
      }, { onLogEntry, cwd: this.workingDirectory });

      if (!result.success) {
        return {
          findings: [{ severity: "critical", message: "Audit failed: Claude session error" }],
          proposalEvaluations: [],
          summary: "Audit failed due to session error",
        };
      }

      const parsed = JSON.parse(result.rawOutput);
      return {
        findings: parsed.findings ?? [],
        proposalEvaluations: parsed.proposalEvaluations ?? [],
        summary: parsed.summary ?? "",
      };
    } catch {
      return {
        findings: [{ severity: "critical", message: "Audit failed: unexpected error" }],
        proposalEvaluations: [],
        summary: "Audit failed due to unexpected error",
      };
    }
  }

  async evaluateProposals(proposals: Proposal[], onLogEntry?: (entry: ProcessLogEntry) => void): Promise<ProposalEvaluation[]> {
    try {
      const systemPrompt = await this.promptBuilder.buildSystemPrompt(AgentRole.SUPEREGO);
      const result = await this.sessionLauncher.launch({
        systemPrompt,
        message: `Evaluate these proposals:\n${JSON.stringify(proposals, null, 2)}`,
      }, { onLogEntry, cwd: this.workingDirectory });

      if (!result.success) {
        return proposals.map(() => ({
          approved: false,
          reason: "Evaluation failed: Claude session error",
        }));
      }

      const parsed = JSON.parse(result.rawOutput);
      return parsed.proposalEvaluations ?? proposals.map(() => ({
        approved: false,
        reason: "No evaluation returned",
      }));
    } catch {
      return proposals.map(() => ({
        approved: false,
        reason: "Evaluation failed: unexpected error",
      }));
    }
  }

  async logAudit(entry: string): Promise<void> {
    this.checker.assertCanAppend(AgentRole.SUPEREGO, SubstrateFileType.PROGRESS);
    await this.appendWriter.append(SubstrateFileType.PROGRESS, `[SUPEREGO] ${entry}`);
  }
}
