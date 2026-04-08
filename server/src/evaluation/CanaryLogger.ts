import * as path from "path";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";

export interface ConvMdStats {
  lines: number;
  kb: number;
}

export interface CanaryRecord {
  timestamp: string;
  cycle: number;
  launcher: string;
  candidateCount: number;
  highPriorityConfidence: number | null;
  parseErrors: number;
  pass: boolean;
  trigger?: "idle" | "api";
  convMdLines?: number;
  convMdKb?: number;
  cPerLine?: number;
  cPerKb?: number;
  postCompaction?: boolean;
}

/**
 * Reads CONVERSATION.md line count and size for canary normalization.
 * Returns null if the file cannot be read (e.g. first run before CONV.md exists).
 */
export async function readConvMdStats(fs: IFileSystem, convMdPath: string): Promise<ConvMdStats | null> {
  try {
    const [content, stat] = await Promise.all([fs.readFile(convMdPath), fs.stat(convMdPath)]);
    const lines = content.split("\n").length;
    const kb = Math.round((stat.size / 1024) * 100) / 100;
    return { lines, kb };
  } catch {
    return null;
  }
}

/**
 * Appends Id cycle observability records to `data/canary-log.jsonl`.
 * Each record captures outcome metrics for a single Id.generateDrives() invocation,
 * enabling agents to verify canary gate criteria without shell access.
 *
 * If `lastResultPath` is provided, the most recent record is also written there
 * as pretty-printed JSON (overwritten on each run). This provides a session-agnostic
 * persistent location that survives `/tmp` cleanup between Ego sessions.
 *
 * When `convMdLines` and `convMdKb` are present on the record, derived normalization
 * fields (`cPerLine`, `cPerKb`) and the `postCompaction` flag are computed automatically.
 *
 * If `counterPath` is provided, `nextApiCycle()` persists a monotonically-incrementing
 * counter across substrate restarts for API-triggered canary runs.
 */
export class CanaryLogger {
  private lastConvMdLines: number | null = null;

  constructor(
    private readonly fs: IFileSystem,
    private readonly filePath: string,
    private readonly lastResultPath?: string,
    private readonly counterPath?: string,
  ) { }

  /**
   * Reads the persistent API cycle counter from `counterPath`, increments it,
   * writes it back, and returns the new value. Starts from 0 on the first call
   * (when the counter file is absent or unreadable).
   *
   * Falls back to 0 on every call when `counterPath` is not configured.
   */
  async nextApiCycle(): Promise<number> {
    if (!this.counterPath) {
      return 0;
    }
    let current = -1;
    try {
      const raw = await this.fs.readFile(this.counterPath);
      const parsed = parseInt(raw.trim(), 10);
      if (!isNaN(parsed) && parsed >= 0) {
        current = parsed;
      }
    } catch {
      // Counter file absent — treat as -1 so the first incremented value is 0.
    }
    const next = current + 1;
    const dir = path.dirname(this.counterPath);
    await this.fs.mkdir(dir, { recursive: true });
    await this.fs.writeFile(this.counterPath, String(next));
    return next;
  }

  /**
   * Appends the record to the log file, enriching it with computed normalization fields
   * (`cPerLine`, `cPerKb`, `postCompaction`) when `convMdLines`/`convMdKb` are present.
   * Returns the enriched record as written to disk.
   */
  async recordCycle(record: CanaryRecord): Promise<CanaryRecord> {
    const dir = path.dirname(this.filePath);
    await this.fs.mkdir(dir, { recursive: true });

    const enriched: CanaryRecord = { ...record };

    if (enriched.convMdLines !== undefined) {
      if (enriched.convMdLines > 0) {
        enriched.cPerLine = Math.round((enriched.candidateCount / enriched.convMdLines) * 1000) / 1000;
      }
      if (this.lastConvMdLines !== null) {
        enriched.postCompaction = enriched.convMdLines < this.lastConvMdLines;
      }
      this.lastConvMdLines = enriched.convMdLines;
    }

    if (enriched.convMdKb !== undefined && enriched.convMdKb > 0) {
      enriched.cPerKb = Math.round((enriched.candidateCount / enriched.convMdKb) * 100) / 100;
    }

    await this.fs.appendFile(this.filePath, JSON.stringify(enriched) + "\n");

    if (this.lastResultPath) {
      const lastResultDir = path.dirname(this.lastResultPath);
      await this.fs.mkdir(lastResultDir, { recursive: true });
      await this.fs.writeFile(this.lastResultPath, JSON.stringify(enriched, null, 2) + "\n");
    }

    return enriched;
  }
}
