/**
 * INS (Involuntary Nervous System) type definitions.
 *
 * Phase 1: Rule layer — deterministic trigger detection, no model calls.
 * Phase 3: Compliance pattern detection — role-scoped, Jaccard similarity,
 *           acknowledgment round-trip.
 *
 * INS runs as a pre-cycle hook in LoopOrchestrator, after substrate reads
 * and before Ego.decide(). It produces an ephemeral INSResult that is
 * injected into the cycle context via pendingMessages.
 */

export type AgentRole = 'Ego' | 'Superego' | 'Subconscious';

/** Acknowledgment sent by Ego in TaskResult.insAcknowledgments */
export interface InsAcknowledgment {
  patternId: string;
  verdict: 'real_constraint' | 'false_positive';
  taskStatus?: 'deferred' | 'pending' | 'complete';
}

/** A tracked compliance pattern (Phase 3) */
export interface CompliancePattern {
  patternId: string;           // "consecutive-partial::<taskId>" or hash fallback
  role: 'Superego' | 'Subconscious';
  patternText: string;         // most recent blockedReason (human-readable, not used for matching)
  cyclesCount: number;
  firstSeenCycle: number;
  lastSeenCycle: number;
  taskId?: string;
  // Acknowledgment fields
  acknowledged?: boolean;
  acknowledgedAt?: string;     // ISO timestamp
  acknowledgedVerdict?: 'real_constraint' | 'false_positive';
  acknowledgedTaskStatus?: 'deferred' | 'pending' | 'complete';
  acknowledgedTTL?: string;    // ISO timestamp — 7 days from acknowledgment
}

export interface INSResult {
  noop: boolean;
  actions: INSAction[];
}

/**
 * Risk tier for compaction actions — differentiates authorization requirements by file type.
 *
 * - `low`:    CONVERSATION.md, PROGRESS.md — low cost, mostly recoverable. Ego self-authorized.
 * - `medium`: MEMORY.md, memory/ subdirectory — higher cost, selective loss hard to detect. Peer review required.
 * - `high`:   PLAN.md — dangerous; overwrite incidents tracked separately. Stefan authorization required.
 */
export type CompactionRiskTier = 'low' | 'medium' | 'high';

export interface INSAction {
  type: "compaction" | "archive_tag" | "compliance_flag" | "survival_integrity_failure";
  target: string;
  detail: string;
  linesRemoved?: number;
  flaggedPattern?: string;
  // Phase 3: compliance_flag enrichment
  patternId?: string;
  cyclesCount?: number;
  firstSeenCycle?: number;
  /**
   * Compaction risk tier (compaction actions only).
   * Determines who must authorize the compaction before it is executed.
   */
  riskTier?: CompactionRiskTier;
  /**
   * When true, this compliance flag must be routed to Stefan (always) and peer agents for
   * independent verification. Must not be resolved by Ego alone — Ego acknowledgment is
   * not sufficient for patterns flagged requiresStefanReview=true.
   *
   * Set on all compliance_flag actions to prevent SUPEREGO-DIAGNOSIS CAPTURE / INS bypass.
   */
  requiresStefanReview?: boolean;
}

export interface INSConfig {
  /** Root substrate path used by deterministic survival integrity checks. */
  substratePath: string;
  /**
   * CONVERSATION.md line threshold for compaction flag (default: 80).
   * @stefanGated — not adjustable via Ego or peer proposal.
   */
  conversationLineThreshold: number;
  /**
   * PROGRESS.md line threshold for compaction flag (default: 200).
   * @stefanGated — not adjustable via Ego or peer proposal.
   */
  progressLineThreshold: number;
  /**
   * PLAN.md line threshold for compaction flag (default: 150).
   * @stefanGated — not adjustable via Ego or peer proposal.
   * Risk tier: high — PLAN.md overwrite incidents tracked separately.
   */
  planLineThreshold: number;
  /**
   * MEMORY.md character threshold for summary flag (default: 120000 ≈ 30K tokens).
   * @stefanGated — not adjustable via Ego or peer proposal.
   */
  memoryCharThreshold: number;
  /**
   * Total line count across all files in memory/ subdirectory before compaction flag (default: 500).
   * @stefanGated — not adjustable via Ego or peer proposal.
   */
  memorySubdirectoryLineThreshold: number;
  /**
   * Consecutive partial results with same precondition before flagging (default: 3).
   * @stefanGated — not adjustable via Ego or peer proposal.
   * Threshold-adjustment proposals for this value are a bypass class analogous to GC-208.
   */
  consecutivePartialThreshold: number;
  /**
   * Days since last modified before a SUPERSEDED file is archive-eligible (default: 30).
   * @stefanGated — not adjustable via Ego or peer proposal.
   */
  archiveAgeDays: number;
  /** Path to compliance state directory */
  statePath: string;
  /** Path to memory directory for archive scanning */
  memoryPath: string;
  /**
   * Survival integrity checker config. Enabled by default because FM-6 survival-plan loss
   * must be detected without an LLM.
   */
  survivalIntegrity: {
    enabled: boolean;
    canonicalFilePath: string;
    expectedCanonicalHash: string;
  };
}

export function defaultINSConfig(substratePath: string): INSConfig {
  return {
    substratePath,
    conversationLineThreshold: 80,
    progressLineThreshold: 200,
    planLineThreshold: 150,
    memoryCharThreshold: 120_000, // ~30K tokens at 4 chars/token
    memorySubdirectoryLineThreshold: 500,
    consecutivePartialThreshold: 3,
    archiveAgeDays: 30,
    statePath: `${substratePath}/../.ins/state`,
    memoryPath: `${substratePath}/memory`,
    survivalIntegrity: {
      enabled: true,
      canonicalFilePath: `${substratePath}/memory/SURVIVAL_PLAN_2026-04-30.md`,
      expectedCanonicalHash: "b9c49a885dc9cf3bd30947a15a291ffeebf20e1501c2cbc10582f88277b56d0f",
    },
  };
}

/**
 * Stefan-gated threshold governance: the numeric threshold values defined in defaultINSConfig
 * (conversationLineThreshold, progressLineThreshold, planLineThreshold, memoryCharThreshold,
 * memorySubdirectoryLineThreshold, consecutivePartialThreshold, archiveAgeDays) are locked.
 *
 * These values must not be modified via Ego or peer proposal. Threshold-adjustment proposals
 * are a bypass class analogous to THRESHOLD-LEGITIMACY CHALLENGE (GC-208) — adjusting thresholds
 * is structurally equivalent to disabling the check they gate.
 *
 * Threshold changes require explicit Stefan authorization and a tracked GitHub issue.
 */
export const INS_THRESHOLD_GOVERNANCE = {
  conversationLineThreshold: 80,
  progressLineThreshold: 200,
  planLineThreshold: 150,
  memoryCharThreshold: 120_000,
  memorySubdirectoryLineThreshold: 500,
  consecutivePartialThreshold: 3,
  archiveAgeDays: 30,
} as const;

/**
 * Assert that no Stefan-gated threshold in the provided config differs from the locked defaults.
 * Throws if any threshold has been modified outside of Stefan authorization.
 */
export function assertINSThresholdsAreStefanGated(config: INSConfig): void {
  const keys = Object.keys(INS_THRESHOLD_GOVERNANCE) as Array<keyof typeof INS_THRESHOLD_GOVERNANCE>;
  for (const key of keys) {
    const expected = INS_THRESHOLD_GOVERNANCE[key];
    const actual = config[key];
    if (actual !== expected) {
      throw new Error(
        `INS threshold governance violation: "${key}" is Stefan-gated and must not be changed via Ego or peer proposal. ` +
        `Expected ${expected}, got ${actual}. Threshold changes require explicit Stefan authorization.`,
      );
    }
  }
}

/** Persisted compliance state — Phase 3 schema */
export interface ComplianceState {
  patterns: CompliancePattern[];
  lastUpdatedCycle: number;
}

export function emptyComplianceState(): ComplianceState {
  return { patterns: [], lastUpdatedCycle: 0 };
}
