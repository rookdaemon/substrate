import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IClock } from "../substrate/abstractions/IClock";
import { AgentRole } from "../agents/types";
import { TaskType } from "../agents/TaskClassifier";
import * as path from "node:path";

/**
 * Single classification event
 */
export interface ClassificationEntry {
  timestamp: string; // ISO 8601
  role: AgentRole;
  operation: string;
  taskType: TaskType;
  model: string;
}

/**
 * Aggregated classification statistics
 */
export interface ClassificationStats {
  totalOperations: number;
  strategicCount: number;
  tacticalCount: number;
  strategicPct: number;
  tacticalPct: number;
  byRole: Record<AgentRole, {
    total: number;
    strategic: number;
    tactical: number;
  }>;
}

/**
 * Interface for components that want to record task classifications
 */
export interface IMetricsCollector {
  recordClassification(
    role: AgentRole,
    operation: string,
    taskType: TaskType,
    model: string
  ): Promise<void>;
}

/**
 * Tracks TaskClassifier decisions to verify model selection routing.
 * 
 * Design:
 * - JSONL append-only format for efficient writes
 * - Stores in ~/.local/share/substrate/.metrics/task_classifications.jsonl
 * - No in-memory cache (pure append-only, aggregation reads from file)
 * - Follows MetricsStore pattern for consistency
 * 
 * Expected usage:
 * - TaskClassifier optionally calls recordClassification() after each decision
 * - Weekly aggregation to verify ~70-80% tactical routing
 */
export class TaskClassificationMetrics implements IMetricsCollector {
  private readonly metricsPath: string;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    substrateDir: string
  ) {
    const metricsDir = `${substrateDir}/.metrics`;
    this.metricsPath = `${metricsDir}/task_classifications.jsonl`;
  }

  /**
   * Record a single classification decision
   */
  async recordClassification(
    role: AgentRole,
    operation: string,
    taskType: TaskType,
    model: string
  ): Promise<void> {
    const entry: ClassificationEntry = {
      timestamp: this.clock.now().toISOString(),
      role,
      operation,
      taskType,
      model,
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
   * Get all classification entries (for aggregation/analysis)
   */
  async getHistory(): Promise<ClassificationEntry[]> {
    try {
      const content = await this.fs.readFile(this.metricsPath);
      const lines = content.trim().split("\n").filter(l => l.trim());
      return lines.map(line => JSON.parse(line));
    } catch {
      return [];
    }
  }

  /**
   * Get classification entries within a time range
   */
  async getHistorySince(since: Date): Promise<ClassificationEntry[]> {
    const allEntries = await this.getHistory();
    const sinceTimestamp = since.toISOString();
    return allEntries.filter(entry => entry.timestamp >= sinceTimestamp);
  }

  /**
   * Aggregate classification statistics
   */
  async getStats(since?: Date): Promise<ClassificationStats> {
    const entries = since ? await this.getHistorySince(since) : await this.getHistory();

    if (entries.length === 0) {
      return {
        totalOperations: 0,
        strategicCount: 0,
        tacticalCount: 0,
        strategicPct: 0,
        tacticalPct: 0,
        byRole: {} as Record<AgentRole, { total: number; strategic: number; tactical: number }>,
      };
    }

    const strategicCount = entries.filter(e => e.taskType === "strategic").length;
    const tacticalCount = entries.filter(e => e.taskType === "tactical").length;

    // Group by role
    const byRole: Record<string, { total: number; strategic: number; tactical: number }> = {};
    for (const entry of entries) {
      if (!byRole[entry.role]) {
        byRole[entry.role] = { total: 0, strategic: 0, tactical: 0 };
      }
      byRole[entry.role].total++;
      if (entry.taskType === "strategic") {
        byRole[entry.role].strategic++;
      } else {
        byRole[entry.role].tactical++;
      }
    }

    return {
      totalOperations: entries.length,
      strategicCount,
      tacticalCount,
      strategicPct: strategicCount / entries.length,
      tacticalPct: tacticalCount / entries.length,
      byRole: byRole as Record<AgentRole, { total: number; strategic: number; tactical: number }>,
    };
  }

  /**
   * Clear all classification history (use with caution)
   */
  async clear(): Promise<void> {
    try {
      await this.fs.unlink(this.metricsPath);
    } catch {
      // File may not exist, ignore
    }
  }
}
