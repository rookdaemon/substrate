import * as path from "path";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";

export interface CanaryRecord {
  timestamp: string;
  cycle: number;
  launcher: string;
  candidateCount: number;
  highPriorityConfidence: number | null;
  parseErrors: number;
  pass: boolean;
  trigger?: "idle" | "api";
}

/**
 * Appends Id cycle observability records to `data/canary-log.jsonl`.
 * Each record captures outcome metrics for a single Id.generateDrives() invocation,
 * enabling agents to verify canary gate criteria without shell access.
 *
 * If `lastResultPath` is provided, the most recent record is also written there
 * as pretty-printed JSON (overwritten on each run). This provides a session-agnostic
 * persistent location that survives `/tmp` cleanup between Ego sessions.
 */
export class CanaryLogger {
  constructor(
    private readonly fs: IFileSystem,
    private readonly filePath: string,
    private readonly lastResultPath?: string,
  ) {}

  async recordCycle(record: CanaryRecord): Promise<void> {
    const dir = path.dirname(this.filePath);
    await this.fs.mkdir(dir, { recursive: true });
    await this.fs.appendFile(this.filePath, JSON.stringify(record) + "\n");

    if (this.lastResultPath) {
      const lastResultDir = path.dirname(this.lastResultPath);
      await this.fs.mkdir(lastResultDir, { recursive: true });
      await this.fs.writeFile(this.lastResultPath, JSON.stringify(record, null, 2) + "\n");
    }
  }
}
