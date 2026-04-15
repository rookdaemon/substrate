import { IFileSystem } from "../../substrate/abstractions/IFileSystem";
import { ILogger } from "../../logging";

export interface Finding {
  severity: "info" | "warning" | "critical";
  /** Stable UPPER_SNAKE_CASE identifier for the finding type. Must NOT include
   *  dynamic data (cycle numbers, GC-NNN, etc.) — the category is the key used
   *  to accumulate history across cycles and reach the escalation threshold.
   *  Valid values: ESCALATE_FILE_EMPTY, CLAUDE_BOUNDARIES_CONFLICT,
   *  SGAB_RECLASSIFICATION, VALUES_RECRUITMENT, SOURCE_CODE_BYPASS,
   *  AUDIT_FAILURE, UNKNOWN_FINDING (and any domain-specific additions). */
  category: string;
  message: string;
}

export interface EscalationInfo {
  findingId: string;
  severity: string;
  message: string;
  cycles: number[];
  firstDetectedCycle: number;
  lastOccurrenceCycle: number;
}

/** Internal representation of a single finding occurrence. */
interface OccurrenceRecord {
  cycle: number;
  /** Unix timestamp in milliseconds (Date.now()). A value of 0 is a sentinel
   *  for legacy entries loaded from pre-Fix-2 state files that stored only
   *  cycle numbers; these are treated as having an unknown (infinitely old)
   *  timestamp and will not contribute to gap-based escalation decisions. */
  ts: number;
  /** Severity reported for this specific occurrence — stored as metadata for
   *  display/reporting purposes.  Must NOT be used as a keying dimension;
   *  the escalation chain key is category-only. */
  severity?: string;
}

export class SuperegoFindingTracker {
  private findingHistory: Map<string, OccurrenceRecord[]> = new Map();
  private readonly CONSECUTIVE_THRESHOLD = 3;
  private readonly WARNING_THRESHOLD = 5;
  /**
   * Maximum time gap (ms) between any two consecutive occurrences for them to
   * be considered part of the same escalation series.  30 days covers any
   * realistic audit-interval variation, including extended Stefan-offline
   * periods, while still detecting stale-then-recurred findings correctly.
   */
  private readonly GAP_THRESHOLD_MS = 30 * 24 * 60 * 60 * 1000;

  /**
   * Generate a stable signature for a finding based on category only.
   * Returns the category as a human-readable key, e.g. "AUDIT_FAILURE".
   *
   * Using category (not severity or message content) ensures the signature is
   * stable across cycles even when the LLM reports the same underlying issue
   * with a different severity level.  Severity fragmentation would prevent
   * recurring findings from ever reaching the CONSECUTIVE_THRESHOLD escalation
   * gate — using a category-only key ensures the full occurrence history
   * accumulates into a single chain regardless of per-cycle severity variation.
   *
   * Severity is preserved as metadata on each OccurrenceRecord for display
   * and reporting purposes.
   */
  generateSignature(finding: Finding): string {
    return finding.category;
  }

  /**
   * Track a finding occurrence at the given cycle number.
   * Returns true if this finding should be escalated (threshold consecutive
   * occurrences within the gap window).
   *
   * @param timestamp  Optional Unix ms timestamp for this occurrence.  Defaults
   *                   to Date.now().  Inject an explicit value in tests.
   */
  track(finding: Finding, cycleNumber: number, timestamp?: number): boolean {
    const ts = timestamp ?? Date.now();
    const signature = this.generateSignature(finding);
    const history = this.findingHistory.get(signature) ?? [];

    history.push({ cycle: cycleNumber, ts, severity: finding.severity });
    this.findingHistory.set(signature, history);

    return this.shouldEscalate(signature);
  }

  /**
   * Check if a finding has reached its escalation threshold with all
   * consecutive occurrences within the 30-day gap window.
   *
   * CRITICAL/INFO findings escalate after CONSECUTIVE_THRESHOLD (3) occurrences.
   * WARNING findings escalate after WARNING_THRESHOLD (5) occurrences.
   *
   * The threshold is derived from the most recent occurrence's stored severity
   * so that a chain that transitions from warning to critical applies the lower
   * (more sensitive) critical threshold going forward.
   */
  shouldEscalate(findingId: string): boolean {
    const history = this.findingHistory.get(findingId);
    if (!history || history.length === 0) return false;

    // Sort by timestamp; examine the most recent `threshold` occurrences.
    const sorted = [...history].sort((a, b) => a.ts - b.ts);

    // Derive threshold from the most recent occurrence's severity (metadata).
    // Falls back to CONSECUTIVE_THRESHOLD when severity is absent (legacy data).
    const mostRecentSeverity = sorted[sorted.length - 1]?.severity;
    const threshold = mostRecentSeverity === "warning"
      ? this.WARNING_THRESHOLD
      : this.CONSECUTIVE_THRESHOLD;

    if (history.length < threshold) return false;

    const lastN = sorted.slice(-threshold);

    // All consecutive pairs must be within GAP_THRESHOLD_MS.
    // ts=0 is a legacy sentinel (unknown timestamp) — treat as infinitely old.
    for (let i = 1; i < lastN.length; i++) {
      const prevTs = lastN[i - 1].ts;
      const currTs = lastN[i].ts;
      if (prevTs === 0 || currTs === 0) return false;
      if (currTs - prevTs > this.GAP_THRESHOLD_MS) return false;
    }

    return true;
  }

  /**
   * Get escalation information for a finding that should be escalated.
   */
  getEscalationInfo(finding: Finding): EscalationInfo | null {
    const signature = this.generateSignature(finding);
    const history = this.findingHistory.get(signature);

    const threshold =
      finding.severity === "warning"
        ? this.WARNING_THRESHOLD
        : this.CONSECUTIVE_THRESHOLD;

    if (!history || history.length < threshold) {
      return null;
    }

    const sorted = [...history].sort((a, b) => a.ts - b.ts);
    const cycles = sorted.map((r) => r.cycle);

    return {
      findingId: signature,
      severity: finding.severity,
      message: finding.message,
      cycles,
      firstDetectedCycle: cycles[0],
      lastOccurrenceCycle: cycles[cycles.length - 1],
    };
  }

  /**
   * Remove a finding from tracking after escalation to avoid repeated escalations.
   */
  clearFinding(findingId: string): void {
    this.findingHistory.delete(findingId);
  }

  /**
   * Get all tracked finding signatures (for testing/debugging).
   */
  getTrackedFindings(): string[] {
    return Array.from(this.findingHistory.keys());
  }

  /**
   * Get cycle-number history for a specific finding (for testing/debugging).
   * Returns cycle numbers in insertion order.
   */
  getFindingHistory(findingId: string): number[] | undefined {
    return this.findingHistory.get(findingId)?.map((r) => r.cycle);
  }

  /**
   * Serialize tracker state to a JSON file for persistence across restarts.
   * Stores full OccurrenceRecord objects (cycle + ts) so gap detection
   * survives restart.
   */
  async save(filePath: string, fs: IFileSystem): Promise<void> {
    const data: Record<string, OccurrenceRecord[]> = {};
    for (const [key, records] of this.findingHistory) {
      data[key] = records;
    }
    await fs.writeFile(filePath, JSON.stringify(data));
  }

  /**
   * Deserialize tracker state from a JSON file.
   * Handles three serialization formats:
   *   - Legacy (pre-Fix-2): { "severity:CATEGORY": number[] }  — cycle numbers only; ts set to 0 sentinel.
   *   - Fix-2:              { "severity:CATEGORY": OccurrenceRecord[] }  — { cycle, ts } objects.
   *   - Current (Fix-10+):  { "CATEGORY": OccurrenceRecord[] }  — category-only key with severity metadata.
   *
   * Keys of the old "severity:CATEGORY" form are automatically migrated to the
   * category-only form so persisted state survives the upgrade without data loss.
   * Returns a fresh tracker if the file does not exist or is corrupted.
   */
  static async load(filePath: string, fs: IFileSystem, logger?: ILogger): Promise<SuperegoFindingTracker> {
    const tracker = new SuperegoFindingTracker();
    try {
      const content = await fs.readFile(filePath);
      const parsed: unknown = JSON.parse(content);
      if (parsed !== null && typeof parsed === "object" && !Array.isArray(parsed)) {
        for (const [rawKey, value] of Object.entries(parsed as Record<string, unknown>)) {
          if (!Array.isArray(value)) continue;

          // Migrate old "severity:CATEGORY" keys to category-only form.
          const severityPrefixMatch = /^(info|warning|critical):(.+)$/.exec(rawKey);
          const migratedSeverity = severityPrefixMatch ? severityPrefixMatch[1] : undefined;
          const key = severityPrefixMatch ? severityPrefixMatch[2] : rawKey;

          if (value.every((v) => typeof v === "number")) {
            // Legacy format: plain cycle-number array — convert with ts=0 sentinel.
            // ts=0 prevents false escalation on stale entries (gap check returns false
            // whenever a sentinel is encountered).
            const existing = tracker.findingHistory.get(key) ?? [];
            const records = (value as number[]).map((cycle) => ({
              cycle,
              ts: 0,
              ...(migratedSeverity ? { severity: migratedSeverity } : {}),
            }));
            tracker.findingHistory.set(key, [...existing, ...records]);
          } else if (
            value.every(
              (v) =>
                v !== null &&
                typeof v === "object" &&
                "cycle" in v &&
                "ts" in v &&
                typeof (v as Record<string, unknown>).cycle === "number" &&
                typeof (v as Record<string, unknown>).ts === "number"
            )
          ) {
            // Current format: OccurrenceRecord array.
            // Back-fill severity from the migrated key prefix when records lack it.
            const existing = tracker.findingHistory.get(key) ?? [];
            const records = (value as OccurrenceRecord[]).map((r) => ({
              ...r,
              severity: r.severity ?? migratedSeverity,
            }));
            tracker.findingHistory.set(key, [...existing, ...records]);
          }
        }
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (!message.includes("ENOENT")) {
        logger?.debug(`SuperegoFindingTracker: could not load state from ${filePath}: ${message}`);
      }
    }
    return tracker;
  }
}
