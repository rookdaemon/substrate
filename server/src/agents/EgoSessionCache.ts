import * as path from "path";
import { IClock } from "../substrate/abstractions/IClock";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";

/**
 * A parsed ego session cache entry, as written by a previous Ego session.
 * The cache is a plain markdown file with a machine-readable header.
 */
export interface EgoSessionCacheEntry {
  /** ISO timestamp when this cache was written. */
  writtenAt: Date;
  /** mtime of PLAN.md at the time of writing (ISO string). */
  planMtime: string;
  /** mtime of OPERATING_CONTEXT.md at the time of writing (ISO string). */
  operatingContextMtime: string;
  /** One-line scope of what was active in the prior session. */
  priorSessionScope: string;
  /** The session notes content (everything after the header). */
  notes: string;
}

const CACHE_FILE = "ego_session_cache.md";
const PREV_FILE = "ego_session_cache.prev";
const DEFAULT_STALENESS_MS = 4 * 60 * 60 * 1000; // 4 hours

const MAX_NOTES_WORDS = 500;

/**
 * EgoSessionCache manages a substrate-level handoff note written by the Ego
 * after each session and read at the start of the next session.
 *
 * Design:
 * - Bounded: overwrites each session, never appends. Only last session's notes kept.
 * - Inspectable: plain markdown, readable by Stefan and future cycles.
 * - Rollback-trivial: delete the file to restore stateless Ego operation.
 * - Fail-closed: pre-launch rename to .prev ensures stale content is never injected
 *   if the session fails before writing a new cache.
 *
 * See drafts/ego_session_continuity_design_2026-06-12.md for full design rationale.
 */
export class EgoSessionCache {
  private readonly cacheFilePath: string;
  private readonly prevFilePath: string;

  constructor(
    private readonly substratePath: string,
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly stalenessMs: number = DEFAULT_STALENESS_MS,
  ) {
    this.cacheFilePath = path.join(substratePath, CACHE_FILE);
    this.prevFilePath = path.join(substratePath, PREV_FILE);
  }

  /**
   * Reads and validates the ego session cache.
   *
   * Returns null when:
   * - The cache file does not exist (file absent = continuity broken)
   * - The cache timestamp is older than the staleness threshold
   * - The PLAN.md or OPERATING_CONTEXT.md mtime has changed since the cache was written
   *
   * Pre-launch behavior: renames cache → .prev before reading, so if the
   * caller's session fails without writing a replacement, the main file is
   * absent (correctly signals: handoff was attempted but not confirmed).
   */
  async read(): Promise<EgoSessionCacheEntry | null> {
    // Check if cache exists before attempting rename
    const cacheExists = await this.fs.exists(this.cacheFilePath);
    if (!cacheExists) {
      return null;
    }

    // Fail-closed: rename cache to .prev before reading.
    // If session fails before writing a new cache, main file is absent.
    // .prev is never injected — it represents an unconfirmed handoff.
    try {
      await this.fs.rename(this.cacheFilePath, this.prevFilePath);
    } catch {
      // If rename fails (race condition or permission issue), treat as cache miss
      return null;
    }

    let raw: string;
    try {
      raw = await this.fs.readFile(this.prevFilePath);
    } catch {
      return null;
    }

    const entry = parseCache(raw);
    if (!entry) {
      return null;
    }

    // Check wall-time staleness
    const ageMs = this.clock.now().getTime() - entry.writtenAt.getTime();
    if (ageMs > this.stalenessMs) {
      return null;
    }

    // Check substrate fingerprint: PLAN.md and OPERATING_CONTEXT.md mtimes
    const planPath = path.join(this.substratePath, "PLAN.md");
    const ocPath = path.join(this.substratePath, "OPERATING_CONTEXT.md");

    try {
      const planStat = await this.fs.stat(planPath);
      const currentPlanMtime = new Date(planStat.mtimeMs).toISOString();
      if (currentPlanMtime !== entry.planMtime) {
        return null;
      }
    } catch {
      // If we can't stat PLAN.md, treat as fingerprint mismatch
      return null;
    }

    try {
      const ocStat = await this.fs.stat(ocPath);
      const currentOcMtime = new Date(ocStat.mtimeMs).toISOString();
      if (currentOcMtime !== entry.operatingContextMtime) {
        return null;
      }
    } catch {
      // If we can't stat OPERATING_CONTEXT.md, treat as fingerprint mismatch
      return null;
    }

    return entry;
  }

  /**
   * Writes ego session notes to the cache file, atomically via temp file + rename.
   * Enforces a ~500-word cap on the notes content.
   *
   * Reads PLAN.md and OPERATING_CONTEXT.md mtimes to build the fingerprint.
   * Fails silently on write errors — cache write must never block session completion.
   */
  async write(notes: string, priorSessionScope: string): Promise<void> {
    const now = this.clock.now();
    const planPath = path.join(this.substratePath, "PLAN.md");
    const ocPath = path.join(this.substratePath, "OPERATING_CONTEXT.md");

    let planMtime = now.toISOString();
    let ocMtime = now.toISOString();

    try {
      const planStat = await this.fs.stat(planPath);
      planMtime = new Date(planStat.mtimeMs).toISOString();
    } catch {
      // Use current time as fallback — fingerprint will mismatch on next read if PLAN.md exists
    }

    try {
      const ocStat = await this.fs.stat(ocPath);
      ocMtime = new Date(ocStat.mtimeMs).toISOString();
    } catch {
      // Use current time as fallback
    }

    // Enforce word cap
    const truncatedNotes = truncateToWords(notes, MAX_NOTES_WORDS);

    const content = formatCache({
      writtenAt: now,
      planMtime,
      operatingContextMtime: ocMtime,
      priorSessionScope,
      notes: truncatedNotes,
    });

    const tmpPath = path.join(this.substratePath, "ego_session_cache.tmp");
    try {
      await this.fs.writeFile(tmpPath, content);
      await this.fs.rename(tmpPath, this.cacheFilePath);
    } catch {
      // Fail silently — cache write must not block session completion
    }
  }
}

/**
 * Formats an EgoSessionCacheEntry as the ego_session_cache.md file content.
 * Header declares its own epistemology so any reader knows what it is.
 */
function formatCache(entry: EgoSessionCacheEntry): string {
  return `# Ego Session Cache
# Advisory only. Expires if: timestamp older than 4h, fingerprint mismatch, or file absent on expected write.
# Fingerprint: PLAN.md mtime=${entry.planMtime} OPERATING_CONTEXT.md mtime=${entry.operatingContextMtime}
# Written: ${entry.writtenAt.toISOString()}
# Prior session: ${entry.priorSessionScope}
# Resume posture: verify-before-continuing

${entry.notes}
`;
}

/**
 * Parses the ego_session_cache.md header format into an EgoSessionCacheEntry.
 * Returns null if the file is malformed or missing required header fields.
 */
function parseCache(raw: string): EgoSessionCacheEntry | null {
  const lines = raw.split("\n");

  let writtenAtStr: string | null = null;
  let planMtime: string | null = null;
  let ocMtime: string | null = null;
  let priorSessionScope: string | null = null;
  let notesStartLine = -1;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];

    if (line.startsWith("# Written: ")) {
      writtenAtStr = line.slice("# Written: ".length).trim();
    } else if (line.startsWith("# Fingerprint: ")) {
      const fp = line.slice("# Fingerprint: ".length).trim();
      const planMatch = fp.match(/PLAN\.md mtime=([^\s]+)/);
      const ocMatch = fp.match(/OPERATING_CONTEXT\.md mtime=([^\s]+)/);
      if (planMatch) planMtime = planMatch[1];
      if (ocMatch) ocMtime = ocMatch[1];
    } else if (line.startsWith("# Prior session: ")) {
      priorSessionScope = line.slice("# Prior session: ".length).trim();
    } else if (line === "# Resume posture: verify-before-continuing") {
      // Notes start after the blank line following this header line
      notesStartLine = i + 2; // skip blank line
      break;
    }
  }

  if (!writtenAtStr || !planMtime || !ocMtime) {
    return null;
  }

  const writtenAt = new Date(writtenAtStr);
  if (isNaN(writtenAt.getTime())) {
    return null;
  }

  const notes = notesStartLine >= 0 && notesStartLine < lines.length
    ? lines.slice(notesStartLine).join("\n").trim()
    : "";

  return {
    writtenAt,
    planMtime,
    operatingContextMtime: ocMtime,
    priorSessionScope: priorSessionScope ?? "",
    notes,
  };
}

/**
 * Truncates text to approximately N words, respecting word boundaries.
 */
function truncateToWords(text: string, maxWords: number): string {
  const words = text.trim().split(/\s+/);
  if (words.length <= maxWords) {
    return text.trim();
  }
  return words.slice(0, maxWords).join(" ") + "\n\n[truncated to 500-word limit]";
}
