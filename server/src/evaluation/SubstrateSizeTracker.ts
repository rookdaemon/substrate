import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IClock } from "../substrate/abstractions/IClock";
import * as path from "node:path";

/**
 * Single size measurement snapshot
 */
export interface SizeSnapshot {
  timestamp: string; // ISO 8601
  files: Record<string, number>; // filename -> line count
  totalBytes: number;
}

/**
 * File size status with target comparison
 */
export interface FileSizeStatus {
  current: number;
  target: number;
  status: "OK" | "WARNING" | "CRITICAL";
  alert?: string;
}

/**
 * Substrate file size targets (from substrate_maintenance.md)
 */
const SIZE_TARGETS: Record<string, number> = {
  "PLAN.md": 100,
  "PROGRESS.md": 200,
  "MEMORY.md": 300,
  "CONVERSATION.md": 200,
  "HABITS.md": 150,
  "SKILLS.md": 200,
  "VALUES.md": 100,
  "ID.md": 100,
  "SECURITY.md": 150,
  "CHARTER.md": 200,
  "SUPEREGO.md": 150,
  "CLAUDE.md": 100,
};

/**
 * Tracks substrate file sizes over time to detect bloat.
 * 
 * Design:
 * - JSONL append-only format for historical size snapshots
 * - Stores in ~/.local/share/substrate/.metrics/substrate_sizes.jsonl
 * - Weekly measurements track all core substrate markdown files
 * - Compares against targets to trigger alerts
 * 
 * Expected usage:
 * - MetricsScheduler calls recordSnapshot() weekly
 * - Health dashboard calls getCurrentStatus() for alerts
 */
export class SubstrateSizeTracker {
  private readonly metricsPath: string;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly substratePath: string
  ) {
    const metricsDir = `${substratePath}/.metrics`;
    this.metricsPath = `${metricsDir}/substrate_sizes.jsonl`;
  }

  /**
   * Record a size snapshot of all substrate files
   */
  async recordSnapshot(): Promise<void> {
    const files: Record<string, number> = {};
    let totalBytes = 0;

    // Measure all substrate markdown files
    for (const filename of Object.keys(SIZE_TARGETS)) {
      const filePath = path.join(this.substratePath, filename);
      try {
        const content = await this.fs.readFile(filePath);
        const lineCount = content.split("\n").length;
        const byteSize = Buffer.byteLength(content, "utf8");
        
        files[filename] = lineCount;
        totalBytes += byteSize;
      } catch {
        // File may not exist, skip
        files[filename] = 0;
      }
    }

    const snapshot: SizeSnapshot = {
      timestamp: this.clock.now().toISOString(),
      files,
      totalBytes,
    };

    // Ensure .metrics directory exists
    const metricsDir = path.dirname(this.metricsPath);
    await this.fs.mkdir(metricsDir, { recursive: true });

    // Append to JSONL file
    const line = JSON.stringify(snapshot) + "\n";
    try {
      const existing = await this.fs.readFile(this.metricsPath);
      await this.fs.writeFile(this.metricsPath, existing + line);
    } catch {
      // File doesn't exist, create it
      await this.fs.writeFile(this.metricsPath, line);
    }
  }

  /**
   * Get all historical snapshots
   */
  async getHistory(): Promise<SizeSnapshot[]> {
    try {
      const content = await this.fs.readFile(this.metricsPath);
      const lines = content.trim().split("\n").filter(l => l.trim());
      return lines.map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Get current file size status with alerts
   */
  async getCurrentStatus(): Promise<Record<string, FileSizeStatus>> {
    const status: Record<string, FileSizeStatus> = {};

    for (const [filename, target] of Object.entries(SIZE_TARGETS)) {
      const filePath = path.join(this.substratePath, filename);
      let current = 0;
      
      try {
        const content = await this.fs.readFile(filePath);
        current = content.split("\n").length;
      } catch {
        // File may not exist
        current = 0;
      }

      const ratio = current / target;
      let fileStatus: "OK" | "WARNING" | "CRITICAL" = "OK";
      let alert: string | undefined;

      if (ratio >= 2.0) {
        fileStatus = "CRITICAL";
        alert = `${ratio.toFixed(1)}x target`;
      } else if (ratio >= 1.5) {
        fileStatus = "WARNING";
        alert = `${ratio.toFixed(1)}x target`;
      }

      status[filename] = {
        current,
        target,
        status: fileStatus,
        alert,
      };
    }

    return status;
  }

  /**
   * Get latest snapshot
   */
  async getLatestSnapshot(): Promise<SizeSnapshot | null> {
    const history = await this.getHistory();
    return history.length > 0 ? history[history.length - 1] : null;
  }

  /**
   * Clear all size history (use with caution)
   */
  async clear(): Promise<void> {
    try {
      await this.fs.unlink(this.metricsPath);
    } catch {
      // File may not exist, ignore
    }
  }
}
