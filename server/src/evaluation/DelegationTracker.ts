import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IClock } from "../substrate/abstractions/IClock";
import * as path from "node:path";

/**
 * Single delegation ratio measurement
 */
export interface DelegationEntry {
  timestamp: string; // ISO 8601
  copilot_issues: number;
  total_coding_issues: number;
  delegation_ratio: number; // 0.0 to 1.0
  week_start: string; // ISO 8601 date (Monday of the week)
}

/**
 * Delegation ratio status
 */
export interface DelegationStatus {
  ratio: number;
  copilot_issues: number;
  total_issues: number;
  status: "OK" | "WARNING" | "CRITICAL";
  alert?: string;
}

/**
 * Tracks delegation ratio to verify offloading pattern compliance.
 * 
 * Design:
 * - JSONL append-only format for weekly delegation measurements
 * - Stores in ~/.local/share/substrate/.metrics/delegation_ratio.jsonl
 * - Target: >80% of coding tasks assigned to Copilot (per HABITS.md)
 * 
 * Expected usage:
 * - MetricsScheduler calls recordDelegationRatio() weekly
 * - Currently stores manual counts (future: GitHub API integration)
 * 
 * Note: This is a placeholder implementation. Full GitHub API integration
 * would require gh CLI or REST API calls to query issue assignments.
 */
export class DelegationTracker {
  private readonly metricsPath: string;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    substrateDir: string
  ) {
    const metricsDir = `${substrateDir}/.metrics`;
    this.metricsPath = `${metricsDir}/delegation_ratio.jsonl`;
  }

  /**
   * Record delegation ratio for a week
   * 
   * @param copilotIssues Number of issues assigned to Copilot
   * @param totalCodingIssues Total number of coding issues
   */
  async recordDelegationRatio(
    copilotIssues: number,
    totalCodingIssues: number
  ): Promise<void> {
    const now = this.clock.now();
    const weekStart = this.getWeekStart(now);
    const ratio = totalCodingIssues > 0 ? copilotIssues / totalCodingIssues : 0;

    const entry: DelegationEntry = {
      timestamp: now.toISOString(),
      copilot_issues: copilotIssues,
      total_coding_issues: totalCodingIssues,
      delegation_ratio: ratio,
      week_start: weekStart.toISOString(),
    };

    // Ensure .metrics directory exists
    const metricsDir = path.dirname(this.metricsPath);
    await this.fs.mkdir(metricsDir, { recursive: true });

    // Append to JSONL file
    const line = JSON.stringify(entry) + "\n";
    try {
      const existing = await this.fs.readFile(this.metricsPath);
      await this.fs.writeFile(this.metricsPath, existing + line);
    } catch {
      // File doesn't exist, create it
      await this.fs.writeFile(this.metricsPath, line);
    }
  }

  /**
   * Get all delegation history
   */
  async getHistory(): Promise<DelegationEntry[]> {
    try {
      const content = await this.fs.readFile(this.metricsPath);
      const lines = content.trim().split("\n").filter(l => l.trim());
      return lines.map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Get latest delegation ratio
   */
  async getLatestEntry(): Promise<DelegationEntry | null> {
    const history = await this.getHistory();
    return history.length > 0 ? history[history.length - 1] : null;
  }

  /**
   * Get delegation status with alerts
   */
  async getDelegationStatus(): Promise<DelegationStatus | null> {
    const latest = await this.getLatestEntry();
    if (!latest) {
      return null;
    }

    let status: "OK" | "WARNING" | "CRITICAL" = "OK";
    let alert: string | undefined;

    if (latest.delegation_ratio < 0.6) {
      status = "CRITICAL";
      alert = `Delegation ratio below 60% (target: >80%)`;
    } else if (latest.delegation_ratio < 0.8) {
      status = "WARNING";
      alert = `Delegation ratio below 80% target`;
    }

    return {
      ratio: latest.delegation_ratio,
      copilot_issues: latest.copilot_issues,
      total_issues: latest.total_coding_issues,
      status,
      alert,
    };
  }

  /**
   * Get week start (Monday) for a given date
   */
  private getWeekStart(date: Date): Date {
    const d = new Date(date);
    const day = d.getDay();
    const diff = d.getDate() - day + (day === 0 ? -6 : 1); // Adjust to Monday
    d.setDate(diff);
    d.setHours(0, 0, 0, 0);
    return d;
  }

  /**
   * Clear all delegation history (use with caution)
   */
  async clear(): Promise<void> {
    try {
      await this.fs.unlink(this.metricsPath);
    } catch {
      // File may not exist, ignore
    }
  }
}
