import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IClock } from "../substrate/abstractions/IClock";

/**
 * Historical health check metrics for trend analysis
 */
export interface HealthMetrics {
  timestamp: string; // ISO 8601
  driftScore: number; // 0-1, percentage of files with structural drift
  consistencyScore: number; // 0-1, percentage of checks passing
  securityScore: number; // 0-1, 1 = fully compliant, 0 = non-compliant
}

/**
 * Baseline metrics established during initialization
 */
export interface BaselineMetrics {
  driftScore: number;
  consistencyScore: number;
  securityScore: number;
  establishedAt: string;
}

/**
 * Trend analysis result showing deviation from baseline
 */
export interface TrendAnalysis {
  driftTrend: "improving" | "stable" | "degrading";
  consistencyTrend: "improving" | "stable" | "degrading";
  securityTrend: "improving" | "stable" | "degrading";
  alerts: TrendAlert[];
}

export interface TrendAlert {
  metric: "drift" | "consistency" | "security";
  severity: "warning" | "critical";
  message: string;
  currentValue: number;
  baselineValue: number;
  deviation: number; // percentage points
}

/**
 * Configuration for trend detection thresholds
 */
export interface TrendConfig {
  warningThreshold: number; // percentage point deviation for warning (default: 0.15)
  criticalThreshold: number; // percentage point deviation for critical (default: 0.30)
  minDataPoints: number; // minimum history entries before trend analysis (default: 3)
}

const DEFAULT_TREND_CONFIG: TrendConfig = {
  warningThreshold: 0.15, // 15% deviation
  criticalThreshold: 0.30, // 30% deviation
  minDataPoints: 3,
};

/**
 * Persists and analyzes health check metrics over time.
 *
 * Stores metrics in substrate/.metrics/health_metrics.jsonl (append-only)
 * Stores baseline in substrate/.metrics/baseline.json
 *
 * Design decisions:
 * - JSONL format for metrics allows efficient append without parsing full file
 * - Separate baseline file for quick reference
 * - In-memory cache of recent metrics for trend analysis
 * - File-based storage (not database) aligns with substrate's filesystem approach
 */
export class MetricsStore {
  private readonly metricsPath: string;
  private readonly baselinePath: string;
  private readonly config: TrendConfig;
  private cachedMetrics: HealthMetrics[] = [];
  private cachedBaseline: BaselineMetrics | null = null;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    substrateDir: string,
    config: Partial<TrendConfig> = {}
  ) {
    const metricsDir = `${substrateDir}/.metrics`;
    this.metricsPath = `${metricsDir}/health_metrics.jsonl`;
    this.baselinePath = `${metricsDir}/baseline.json`;
    this.config = { ...DEFAULT_TREND_CONFIG, ...config };
  }

  /**
   * Record a new health check result
   */
  async record(metrics: Omit<HealthMetrics, "timestamp">): Promise<void> {
    const entry: HealthMetrics = {
      ...metrics,
      timestamp: this.clock.now().toISOString(),
    };

    // Ensure .metrics directory exists
    const metricsDir = this.metricsPath.substring(0, this.metricsPath.lastIndexOf("/"));
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

    // Update in-memory cache
    this.cachedMetrics.push(entry);

    // Keep cache bounded (last 100 entries)
    if (this.cachedMetrics.length > 100) {
      this.cachedMetrics = this.cachedMetrics.slice(-100);
    }
  }

  /**
   * Establish baseline metrics (typically called during initialization)
   */
  async setBaseline(metrics: Omit<BaselineMetrics, "establishedAt">): Promise<void> {
    const baseline: BaselineMetrics = {
      ...metrics,
      establishedAt: this.clock.now().toISOString(),
    };

    // Ensure .metrics directory exists
    const metricsDir = this.baselinePath.substring(0, this.baselinePath.lastIndexOf("/"));
    await this.fs.mkdir(metricsDir, { recursive: true });

    await this.fs.writeFile(this.baselinePath, JSON.stringify(baseline, null, 2));
    this.cachedBaseline = baseline;
  }

  /**
   * Get current baseline (or null if not established)
   */
  async getBaseline(): Promise<BaselineMetrics | null> {
    if (this.cachedBaseline) {
      return this.cachedBaseline;
    }

    try {
      const content = await this.fs.readFile(this.baselinePath);
      this.cachedBaseline = JSON.parse(content);
      return this.cachedBaseline;
    } catch {
      return null;
    }
  }

  /**
   * Get recent metrics history (default: last 50 entries)
   */
  async getHistory(limit = 50): Promise<HealthMetrics[]> {
    // Use cache if available
    if (this.cachedMetrics.length > 0) {
      return this.cachedMetrics.slice(-limit);
    }

    // Load from file
    try {
      const content = await this.fs.readFile(this.metricsPath);
      const lines = content.trim().split("\n").filter(l => l.trim());
      this.cachedMetrics = lines.map(line => JSON.parse(line));
      return this.cachedMetrics.slice(-limit);
    } catch {
      return [];
    }
  }

  /**
   * Analyze trends and detect significant deviations from baseline
   */
  async analyzeTrends(): Promise<TrendAnalysis> {
    const baseline = await this.getBaseline();
    const history = await this.getHistory(10); // Last 10 data points for trend

    // If no baseline or insufficient history, return stable trends with no alerts
    if (!baseline || history.length < this.config.minDataPoints) {
      return {
        driftTrend: "stable",
        consistencyTrend: "stable",
        securityTrend: "stable",
        alerts: [],
      };
    }

    // Calculate recent average (last 3 data points)
    const recentCount = Math.min(3, history.length);
    const recent = history.slice(-recentCount);

    const avgDrift = recent.reduce((sum, m) => sum + m.driftScore, 0) / recentCount;
    const avgConsistency = recent.reduce((sum, m) => sum + m.consistencyScore, 0) / recentCount;
    const avgSecurity = recent.reduce((sum, m) => sum + m.securityScore, 0) / recentCount;

    // Determine trends
    const driftTrend = this.determineTrend(avgDrift, baseline.driftScore, true); // lower is better
    const consistencyTrend = this.determineTrend(avgConsistency, baseline.consistencyScore, false);
    const securityTrend = this.determineTrend(avgSecurity, baseline.securityScore, false);

    // Generate alerts for significant deviations
    const alerts: TrendAlert[] = [];

    // Drift alerts (higher is worse)
    const driftDeviation = avgDrift - baseline.driftScore;
    if (driftDeviation >= this.config.criticalThreshold) {
      alerts.push({
        metric: "drift",
        severity: "critical",
        message: `Drift score increased ${(driftDeviation * 100).toFixed(1)}% from baseline`,
        currentValue: avgDrift,
        baselineValue: baseline.driftScore,
        deviation: driftDeviation,
      });
    } else if (driftDeviation >= this.config.warningThreshold) {
      alerts.push({
        metric: "drift",
        severity: "warning",
        message: `Drift score increased ${(driftDeviation * 100).toFixed(1)}% from baseline`,
        currentValue: avgDrift,
        baselineValue: baseline.driftScore,
        deviation: driftDeviation,
      });
    }

    // Consistency alerts (lower is worse)
    const consistencyDeviation = baseline.consistencyScore - avgConsistency;
    if (consistencyDeviation >= this.config.criticalThreshold) {
      alerts.push({
        metric: "consistency",
        severity: "critical",
        message: `Consistency score decreased ${(consistencyDeviation * 100).toFixed(1)}% from baseline`,
        currentValue: avgConsistency,
        baselineValue: baseline.consistencyScore,
        deviation: consistencyDeviation,
      });
    } else if (consistencyDeviation >= this.config.warningThreshold) {
      alerts.push({
        metric: "consistency",
        severity: "warning",
        message: `Consistency score decreased ${(consistencyDeviation * 100).toFixed(1)}% from baseline`,
        currentValue: avgConsistency,
        baselineValue: baseline.consistencyScore,
        deviation: consistencyDeviation,
      });
    }

    // Security alerts (lower is worse)
    const securityDeviation = baseline.securityScore - avgSecurity;
    if (securityDeviation >= this.config.criticalThreshold) {
      alerts.push({
        metric: "security",
        severity: "critical",
        message: `Security score decreased ${(securityDeviation * 100).toFixed(1)}% from baseline`,
        currentValue: avgSecurity,
        baselineValue: baseline.securityScore,
        deviation: securityDeviation,
      });
    } else if (securityDeviation >= this.config.warningThreshold) {
      alerts.push({
        metric: "security",
        severity: "warning",
        message: `Security score decreased ${(securityDeviation * 100).toFixed(1)}% from baseline`,
        currentValue: avgSecurity,
        baselineValue: baseline.securityScore,
        deviation: securityDeviation,
      });
    }

    return {
      driftTrend,
      consistencyTrend,
      securityTrend,
      alerts,
    };
  }

  /**
   * Determine trend direction
   * @param current Current average value
   * @param baseline Baseline value
   * @param lowerIsBetter If true, decreasing values are improvements
   */
  private determineTrend(
    current: number,
    baseline: number,
    lowerIsBetter: boolean
  ): "improving" | "stable" | "degrading" {
    const delta = current - baseline;
    const threshold = 0.05; // 5% threshold for "stable"

    if (Math.abs(delta) < threshold) {
      return "stable";
    }

    if (lowerIsBetter) {
      return delta < 0 ? "improving" : "degrading";
    } else {
      return delta > 0 ? "improving" : "degrading";
    }
  }

  /**
   * Clear all historical metrics (use with caution)
   */
  async clear(): Promise<void> {
    try {
      await this.fs.unlink(this.metricsPath);
      await this.fs.unlink(this.baselinePath);
    } catch {
      // Files may not exist, ignore
    }
    this.cachedMetrics = [];
    this.cachedBaseline = null;
  }
}
