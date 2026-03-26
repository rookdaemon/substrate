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
 * When `convMdLines` and `convMdKb` are present on the record, derived normalization
 * fields (`cPerLine`, `cPerKb`) and the `postCompaction` flag are computed automatically.
 */
export class CanaryLogger {
  private lastConvMdLines: number | null = null;

  constructor(
    private readonly fs: IFileSystem,
    private readonly filePath: string,
  ) {}

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
    return enriched;
  }
}
