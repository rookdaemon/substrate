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

export interface INSAction {
  type: "compaction" | "archive_tag" | "compliance_flag";
  target: string;
  detail: string;
  linesRemoved?: number;
  flaggedPattern?: string;
  // Phase 3: compliance_flag enrichment
  patternId?: string;
  cyclesCount?: number;
  firstSeenCycle?: number;
}

export interface INSConfig {
  /** CONVERSATION.md line threshold for compaction flag (default: 80) */
  conversationLineThreshold: number;
  /** PROGRESS.md line threshold for compaction flag (default: 200) */
  progressLineThreshold: number;
  /** MEMORY.md character threshold for summary flag (default: 120000 ≈ 30K tokens) */
  memoryCharThreshold: number;
  /** Total line count across all files in memory/ subdirectory before compaction flag (default: 500) */
  memorySubdirectoryLineThreshold: number;
  /** Consecutive partial results with same precondition before flagging (default: 3) */
  consecutivePartialThreshold: number;
  /** Days since last modified before a SUPERSEDED file is archive-eligible (default: 30) */
  archiveAgeDays: number;
  /** Path to compliance state directory */
  statePath: string;
  /** Path to memory directory for archive scanning */
  memoryPath: string;
}

export function defaultINSConfig(substratePath: string): INSConfig {
  return {
    conversationLineThreshold: 80,
    progressLineThreshold: 200,
    memoryCharThreshold: 120_000, // ~30K tokens at 4 chars/token
    memorySubdirectoryLineThreshold: 500,
    consecutivePartialThreshold: 3,
    archiveAgeDays: 30,
    statePath: `${substratePath}/../.ins/state`,
    memoryPath: `${substratePath}/memory`,
  };
}

/** Persisted compliance state — Phase 3 schema */
export interface ComplianceState {
  patterns: CompliancePattern[];
  lastUpdatedCycle: number;
}

export function emptyComplianceState(): ComplianceState {
  return { patterns: [], lastUpdatedCycle: 0 };
}
