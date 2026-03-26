import { SubstrateFileReader } from "../../substrate/io/FileReader";
import { SubstrateFileType } from "../../substrate/types";
import { IFileSystem } from "../../substrate/abstractions/IFileSystem";
import { IClock } from "../../substrate/abstractions/IClock";
import { ILogger } from "../../logging";
import { INSResult, INSAction, INSConfig, InsAcknowledgment } from "./types";
import { ComplianceStateManager } from "./ComplianceStateManager";

/** Precondition extraction patterns — matches common blocking language in task summaries */
const PRECONDITION_PATTERNS = [
  /(?:blocked by|waiting for|precondition:|awaiting|depends on|gated on)\s*["""]?(.+?)["""]?\s*$/im,
  /(?:cannot proceed|unable to continue).*?(?:until|because)\s+(.+?)$/im,
];

/**
 * Minimum token count for Jaccard similarity matching.
 * Below this threshold, fall back to substring matching.
 * Calibration note: set conservatively to avoid spurious matches on
 * short, formulaic blockedReason strings. Revisit after 2-3 weeks
 * production data.
 */
const JACCARD_MIN_TOKENS = 10;

/** Jaccard similarity threshold for semantic equivalence matching */
const JACCARD_THRESHOLD = 0.6;

/** Re-trigger threshold for false_positive acknowledged patterns (half of normal threshold) */
const FALSE_POSITIVE_RETRIGGER_DIVISOR = 2;

/**
 * INS (Involuntary Nervous System) Phase 3: Rule Layer + Compliance Pattern Detection.
 *
 * Deterministic pre-cycle hook that runs five substrate health checks (Phase 1)
 * plus role-scoped compliance pattern detection (Phase 3).
 *
 * Phase 3 additions:
 * - Role filter: Ego outputs are excluded from this substrate's Layer 3 pattern tracking
 *   due to same-substrate circularity (see checkConsecutivePartials for full rationale)
 * - PatternId scheme: "consecutive-partial::<taskId>" or hash fallback
 * - Jaccard similarity matching with token-count floor for semantic equivalence
 * - Acknowledgment round-trip: Ego can acknowledge patterns via insAcknowledgments
 *
 * No model calls. Never throws. Returns INSResult with zero or more actions.
 * Budget: < 500ms total. Noop cycles produce zero I/O.
 */
export class INSHook {
  constructor(
    private readonly reader: SubstrateFileReader,
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly logger: ILogger,
    private readonly config: INSConfig,
    private readonly complianceState: ComplianceStateManager,
  ) {}

  async evaluate(
    cycleNumber: number,
    lastTaskResult?: {
      result: string;
      summary?: string;
      role?: string;
      taskId?: string;
      blockedReason?: string;
      insAcknowledgments?: InsAcknowledgment[];
    },
  ): Promise<INSResult> {
    const actions: INSAction[] = [];

    try {
      // Rule 1: CONVERSATION.md compaction
      const convAction = await this.checkFileLineCount(
        SubstrateFileType.CONVERSATION,
        "CONVERSATION.md",
        this.config.conversationLineThreshold,
      );
      if (convAction) actions.push(convAction);

      // Rule 2: PROGRESS.md compaction
      const progAction = await this.checkFileLineCount(
        SubstrateFileType.PROGRESS,
        "PROGRESS.md",
        this.config.progressLineThreshold,
      );
      if (progAction) actions.push(progAction);

      // Rule 3: MEMORY.md size
      const memAction = await this.checkMemorySize();
      if (memAction) actions.push(memAction);

      // Rule 4 (Phase 3): Consecutive-partial detection with role filter + Jaccard
      const partialActions = await this.checkConsecutivePartials(cycleNumber, lastTaskResult);
      actions.push(...partialActions);

      // Rule 5: Archive candidates
      const archiveActions = await this.checkArchiveCandidates();
      actions.push(...archiveActions);

      // Rule 6: memory/ subdirectory accumulation
      const subdirAction = await this.checkSubdirectoryAccumulation();
      if (subdirAction) actions.push(subdirAction);
    } catch (err) {
      // INS never blocks the cycle
      this.logger.debug(
        `ins: evaluate failed — ${err instanceof Error ? err.message : String(err)}`,
      );
      return { noop: true, actions: [] };
    }

    if (actions.length > 0) {
      this.logger.debug(
        `ins: cycle ${cycleNumber} — ${actions.length} action(s): ${actions.map((a) => a.type).join(", ")}`,
      );
    }

    return { noop: actions.length === 0, actions };
  }

  // --- Private rule methods ---

  private async checkFileLineCount(
    fileType: SubstrateFileType,
    fileName: string,
    threshold: number,
  ): Promise<INSAction | null> {
    try {
      const content = await this.reader.read(fileType);
      const lineCount = content.rawMarkdown.split("\n").length;
      if (lineCount > threshold) {
        return {
          type: "compaction",
          target: fileName,
          detail: `Line count ${lineCount} exceeds threshold ${threshold} — compaction recommended`,
        };
      }
    } catch {
      // File might not exist — not an error
    }
    return null;
  }

  private async checkMemorySize(): Promise<INSAction | null> {
    try {
      const content = await this.reader.read(SubstrateFileType.MEMORY);
      const charCount = content.rawMarkdown.length;
      if (charCount > this.config.memoryCharThreshold) {
        const estimatedTokens = Math.round(charCount / 4);
        return {
          type: "compaction",
          target: "MEMORY.md",
          detail: `Character count ${charCount} (~${estimatedTokens} tokens) exceeds threshold — summary recommended`,
        };
      }
    } catch {
      // File might not exist
    }
    return null;
  }

  /**
   * Phase 3: Compliance pattern detection.
   *
   * Layer 3 scope: Superego and Subconscious role outputs ONLY.
   *
   * Ego is excluded from *this substrate's* Layer 3 due to same-substrate circularity —
   * Ego assessing its own compliance via a subprocess it controls is structurally circular
   * in a way that can't be resolved by wiring. Network-level cross-agent Ego monitoring
   * (another agent's INS flagging this agent's Ego patterns) is a different topology and
   * remains a live design space, out of scope for Phase 3.
   *
   * Ego compliance monitoring is delegated to cross-agent adversarial review (Rook, Bishop,
   * Nova) as the structural substitute for substrate-local Layer 3 coverage. This is not a
   * workaround; it is the architecturally correct location for this monitoring —
   * same-substrate circularity makes peer review the only non-circular option.
   */
  private async checkConsecutivePartials(
    cycleNumber: number,
    lastTaskResult?: {
      result: string;
      summary?: string;
      role?: string;
      taskId?: string;
      blockedReason?: string;
      insAcknowledgments?: InsAcknowledgment[];
    },
  ): Promise<INSAction[]> {
    if (!lastTaskResult) return [];
    const now = this.clock.now();

    // Process acknowledgments first (from previous cycle's Ego response)
    if (lastTaskResult.insAcknowledgments?.length) {
      for (const ack of lastTaskResult.insAcknowledgments) {
        this.complianceState.applyAcknowledgment(ack.patternId, ack, now);
        // Clear false_positive patterns immediately
        if (ack.verdict === 'false_positive') {
          this.complianceState.clearPattern(ack.patternId);
        }
      }
      if (this.complianceState.isDirty()) {
        await this.complianceState.save();
      }
    }

    // Role filter: Ego outputs are excluded from this substrate's Layer 3 (same-substrate circularity)
    const role = lastTaskResult.role;
    if (role === 'Ego') {
      return [];
    }

    // Determine effective role for tracking (default to Subconscious for backward compat)
    const effectiveRole: 'Superego' | 'Subconscious' =
      role === 'Superego' ? 'Superego' : 'Subconscious';

    if (lastTaskResult.result === "partial") {
      // Extract the blocking reason
      const patternText = lastTaskResult.blockedReason ??
        this.extractPrecondition(lastTaskResult.summary) ??
        lastTaskResult.summary ??
        "";

      if (!patternText) return [];

      // Derive patternId
      const patternId = lastTaskResult.taskId
        ? `consecutive-partial::${lastTaskResult.taskId}`
        : `consecutive-partial::${this.hashText(patternText)}`;

      // Check if an existing pattern matches (by patternId or Jaccard similarity)
      const existingPattern = this.complianceState.findPattern(patternId) ??
        this.findPatternBySimilarity(patternText, cycleNumber);

      const resolvedPatternId = existingPattern?.patternId ?? patternId;

      // Record or increment
      const pattern = this.complianceState.recordOrUpdatePattern(
        resolvedPatternId,
        effectiveRole,
        patternText,
        cycleNumber,
        lastTaskResult.taskId,
      );
      await this.complianceState.save();

      // Check if pattern has reached threshold and should emit a flag
      return this.buildComplianceFlags([pattern]);
    } else if (lastTaskResult.result === "success") {
      // Clear patterns for this specific task if taskId is known
      if (lastTaskResult.taskId) {
        const patternId = `consecutive-partial::${lastTaskResult.taskId}`;
        this.complianceState.clearPattern(patternId);
      } else {
        // Legacy path: no taskId available — clear all (backward-compat with Phase 1)
        this.complianceState.clearAll();
      }
      if (this.complianceState.isDirty()) {
        await this.complianceState.save();
      }
    }

    return [];
  }

  /** Build compliance flag actions for patterns at or above threshold */
  private buildComplianceFlags(patterns: ReturnType<ComplianceStateManager['findPattern']>[]): INSAction[] {
    const actions: INSAction[] = [];
    const threshold = this.config.consecutivePartialThreshold;
    const now = this.clock.now();

    for (const pattern of patterns) {
      if (!pattern) continue;

      // Determine effective threshold (false_positive verdict halves re-trigger threshold)
      const effectiveThreshold = pattern.acknowledgedVerdict === 'false_positive'
        ? Math.max(1, Math.ceil(threshold / FALSE_POSITIVE_RETRIGGER_DIVISOR))
        : threshold;

      if (pattern.cyclesCount < effectiveThreshold) continue;

      // Check acknowledgment — suppress if acknowledged with valid TTL
      if (pattern.acknowledged && pattern.acknowledgedTTL) {
        const ttlExpiry = new Date(pattern.acknowledgedTTL);
        if (now < ttlExpiry) {
          // Still within TTL — suppress flag (unless false_positive re-trigger)
          if (pattern.acknowledgedVerdict !== 'false_positive') continue;
        }
      }

      actions.push({
        type: "compliance_flag",
        target: pattern.role,
        detail: `Consecutive-partial pattern detected (${pattern.cyclesCount} cycles, ${pattern.role}). Stated precondition: "${pattern.patternText}". Not verified in PLAN.md or conversation history. Possible constructed constraint — examine whether this precondition is real.`,
        flaggedPattern: pattern.patternText,
        patternId: pattern.patternId,
        cyclesCount: pattern.cyclesCount,
        firstSeenCycle: pattern.firstSeenCycle,
      });
    }

    return actions;
  }

  /** Find an existing pattern whose patternText is semantically equivalent */
  private findPatternBySimilarity(
    patternText: string,
    _cycleNumber: number,
  ): ReturnType<ComplianceStateManager['findPattern']> {
    const state = this.complianceState.getState();
    for (const pattern of state.patterns) {
      if (this.patternsMatch(patternText, pattern.patternText)) {
        return this.complianceState.findPattern(pattern.patternId);
      }
    }
    return undefined;
  }

  /**
   * Semantic equivalence check for blockedReason strings.
   *
   * Strategy:
   * - Normalize both strings (lowercase, strip punctuation, collapse whitespace)
   * - If either string has < JACCARD_MIN_TOKENS tokens: use substring matching
   * - Otherwise: use Jaccard similarity with JACCARD_THRESHOLD
   *
   * Calibration note: JACCARD_MIN_TOKENS=10, JACCARD_THRESHOLD=0.6 are
   * heuristic values. Calibrate from first 2-3 weeks of production data.
   * For short, formulaic Superego blockedReason strings (e.g. "BLOCK: scope
   * limit exceeded"), substring matching is more reliable than Jaccard.
   */
  private patternsMatch(a: string, b: string): boolean {
    const normA = this.normalizeText(a);
    const normB = this.normalizeText(b);
    const tokensA = normA.split(/\s+/).filter(Boolean);
    const tokensB = normB.split(/\s+/).filter(Boolean);
    const minTokens = Math.min(tokensA.length, tokensB.length);

    if (minTokens < JACCARD_MIN_TOKENS) {
      // Short string path: substring matching
      return normA.includes(normB) || normB.includes(normA);
    }

    return this.jaccardSimilarity(tokensA, tokensB) >= JACCARD_THRESHOLD;
  }

  private normalizeText(s: string): string {
    return s.toLowerCase().replace(/[^\w\s]/g, ' ').replace(/\s+/g, ' ').trim();
  }

  private jaccardSimilarity(tokensA: string[], tokensB: string[]): number {
    const setA = new Set(tokensA);
    const setB = new Set(tokensB);
    if (setA.size === 0 && setB.size === 0) return 1.0;
    if (setA.size === 0 || setB.size === 0) return 0.0;
    let intersectionCount = 0;
    for (const token of setA) {
      if (setB.has(token)) intersectionCount++;
    }
    const unionSize = setA.size + setB.size - intersectionCount;
    return intersectionCount / unionSize;
  }

  /** Simple FNV-1a-inspired hash for patternId fallback when taskId is absent */
  private hashText(s: string): string {
    const normalized = this.normalizeText(s).slice(0, 64);
    let hash = 2166136261;
    for (let i = 0; i < normalized.length; i++) {
      hash ^= normalized.charCodeAt(i);
      hash = (hash * 16777619) >>> 0;
    }
    return hash.toString(16);
  }

  private extractPrecondition(summary?: string): string | null {
    if (!summary) return null;
    for (const pattern of PRECONDITION_PATTERNS) {
      const match = summary.match(pattern);
      if (match?.[1]) {
        return match[1].trim();
      }
    }
    return null;
  }

  private async checkSubdirectoryAccumulation(): Promise<INSAction | null> {
    try {
      const dirExists = await this.fs.exists(this.config.memoryPath);
      if (!dirExists) return null;

      const entries = await this.fs.readdir(this.config.memoryPath);
      let totalLines = 0;
      for (const entry of entries) {
        const filePath = `${this.config.memoryPath}/${entry}`;
        try {
          const stat = await this.fs.stat(filePath);
          if (!stat.isFile) continue;
          const content = await this.fs.readFile(filePath);
          totalLines += content.split("\n").length;
        } catch {
          // Individual file errors are not fatal
        }
      }

      if (totalLines > this.config.memorySubdirectoryLineThreshold) {
        return {
          type: "compaction",
          target: "memory/",
          detail: `memory/ subdirectory total line count ${totalLines} exceeds threshold ${this.config.memorySubdirectoryLineThreshold} — compaction recommended`,
        };
      }
    } catch {
      // Directory read errors are not fatal
    }
    return null;
  }

  private async checkArchiveCandidates(): Promise<INSAction[]> {
    const actions: INSAction[] = [];
    try {
      const dirExists = await this.fs.exists(this.config.memoryPath);
      if (!dirExists) return actions;

      const entries = await this.fs.readdir(this.config.memoryPath);
      // Performance guard: skip if too many files
      if (entries.length > 100) {
        this.logger.debug(`ins: memory/ has ${entries.length} files — skipping archive scan (>100)`);
        return actions;
      }

      const now = this.clock.now().getTime();
      const ageThresholdMs = this.config.archiveAgeDays * 24 * 60 * 60 * 1000;

      for (const entry of entries) {
        const filePath = `${this.config.memoryPath}/${entry}`;
        try {
          const stat = await this.fs.stat(filePath);
          if (!stat.isFile) continue;

          // Two-pass: check age first, then read content only for old files
          const ageMs = now - stat.mtimeMs;
          if (ageMs < ageThresholdMs) continue;

          const content = await this.fs.readFile(filePath);
          if (/SUPERSEDED/i.test(content)) {
            const ageDays = Math.round(ageMs / (24 * 60 * 60 * 1000));
            actions.push({
              type: "archive_tag",
              target: entry,
              detail: `File is ${ageDays} days old and contains SUPERSEDED marker — archive candidate`,
            });
          }
        } catch {
          // Individual file errors are not fatal
        }
      }
    } catch {
      // Directory read errors are not fatal
    }
    return actions;
  }
}
