import { createHash } from "node:crypto";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";

export const SURVIVAL_PLAN_FILE_NAME = "SURVIVAL_PLAN_2026-04-30.md";
export const SURVIVAL_PLAN_REFERENCE = `@memory/${SURVIVAL_PLAN_FILE_NAME}`;
export const DEFAULT_SURVIVAL_PLAN_SHA256 =
  "b9c49a885dc9cf3bd30947a15a291ffeebf20e1501c2cbc10582f88277b56d0f";

export interface SurvivalIntegrityConfig {
  substratePath: string;
  canonicalFilePath?: string;
  expectedCanonicalHash?: string;
}

export interface SurvivalIntegrityIssue {
  code:
    | "missing_plan"
    | "missing_governance_anchor"
    | "missing_active_status"
    | "missing_canonical_reference"
    | "missing_canonical_file"
    | "canonical_hash_mismatch"
    | "missing_persistence_rule"
    | "missing_plan_compaction_guard";
  detail: string;
}

export interface SurvivalIntegrityResult {
  ok: boolean;
  issues: SurvivalIntegrityIssue[];
  canonicalFilePath: string;
  actualCanonicalHash?: string;
}

export class SurvivalIntegrityChecker {
  private readonly canonicalFilePath: string;
  private readonly expectedCanonicalHash: string;

  constructor(
    private readonly fs: IFileSystem,
    private readonly config: SurvivalIntegrityConfig,
  ) {
    this.canonicalFilePath =
      config.canonicalFilePath ?? `${config.substratePath}/memory/${SURVIVAL_PLAN_FILE_NAME}`;
    this.expectedCanonicalHash =
      config.expectedCanonicalHash ?? DEFAULT_SURVIVAL_PLAN_SHA256;
  }

  async check(): Promise<SurvivalIntegrityResult> {
    const issues: SurvivalIntegrityIssue[] = [];
    const planPath = `${this.config.substratePath}/PLAN.md`;

    let plan = "";
    try {
      plan = await this.fs.readFile(planPath);
    } catch {
      issues.push({
        code: "missing_plan",
        detail: `PLAN.md is missing at ${planPath}`,
      });
    }

    if (plan) {
      this.checkPlan(plan, issues);
    }

    let actualCanonicalHash: string | undefined;
    try {
      const canonicalContent = await this.fs.readFile(this.canonicalFilePath);
      actualCanonicalHash = createHash("sha256").update(canonicalContent).digest("hex");
      if (actualCanonicalHash !== this.expectedCanonicalHash) {
        issues.push({
          code: "canonical_hash_mismatch",
          detail: `Canonical survival plan hash mismatch for ${this.canonicalFilePath}: expected ${this.expectedCanonicalHash}, got ${actualCanonicalHash}`,
        });
      }
    } catch {
      issues.push({
        code: "missing_canonical_file",
        detail: `Canonical survival plan file is missing at ${this.canonicalFilePath}`,
      });
    }

    return {
      ok: issues.length === 0,
      issues,
      canonicalFilePath: this.canonicalFilePath,
      actualCanonicalHash,
    };
  }

  private checkPlan(plan: string, issues: SurvivalIntegrityIssue[]): void {
    if (!plan.includes("## SURVIVAL MODE GOVERNANCE")) {
      issues.push({
        code: "missing_governance_anchor",
        detail: "PLAN.md is missing the SURVIVAL MODE GOVERNANCE anchor",
      });
    }

    const hasProtectedStatus =
      /\*\*Status:\*\*\s*ACTIVE/.test(plan) ||
      /\*\*Status:\*\*\s*LONG-TERM SURVIVAL HARDENING/.test(plan);
    if (!hasProtectedStatus) {
      issues.push({
        code: "missing_active_status",
        detail: "PLAN.md survival governance does not state an active or long-term hardening status",
      });
    }

    if (!plan.includes(SURVIVAL_PLAN_REFERENCE) && !plan.includes(this.canonicalFilePath)) {
      issues.push({
        code: "missing_canonical_reference",
        detail: `PLAN.md is missing the canonical survival plan reference (${SURVIVAL_PLAN_REFERENCE} or ${this.canonicalFilePath})`,
      });
    }

    const hasPersistenceRule =
      plan.includes("may NOT be silently compacted") &&
      plan.includes("Removal requires explicit Stefan rescission");
    if (!hasPersistenceRule) {
      issues.push({
        code: "missing_persistence_rule",
        detail: "PLAN.md is missing the survival persistence rule forbidding silent compaction/removal",
      });
    }

    const hasCompactionGuard =
      plan.includes("Do not replace this section with pointers") ||
      plan.includes("Do not propose moving, relocating, or replacing PLAN.md sections with pointers");
    if (!hasCompactionGuard) {
      issues.push({
        code: "missing_plan_compaction_guard",
        detail: "PLAN.md is missing the protected compaction rule that forbids replacing survival governance with pointers",
      });
    }
  }
}
