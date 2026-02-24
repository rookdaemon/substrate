import { SubstrateFileReader } from "../substrate/io/FileReader";
import { DriftAnalyzer, DriftResult } from "./DriftAnalyzer";
import { ConsistencyChecker, ConsistencyResult } from "./ConsistencyChecker";
import { SecurityAnalyzer, SecurityResult } from "./SecurityAnalyzer";
import { PlanQualityEvaluator, PlanQualityResult } from "./PlanQualityEvaluator";
import { ReasoningValidator, ReasoningResult } from "./ReasoningValidator";
import { MetricsStore, TrendAnalysis } from "./MetricsStore";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";

export interface HealthCheckResult {
  overall: "healthy" | "degraded" | "unhealthy";
  drift: DriftResult;
  consistency: ConsistencyResult;
  security: SecurityResult;
  planQuality: PlanQualityResult;
  reasoning: ReasoningResult;
  trends?: TrendAnalysis; // Optional trend analysis (only available after baseline is established)
}

export interface CriticalChecksResult {
  healthy: boolean;
  substrateFsWritable: "healthy" | "unhealthy";
}

export class HealthCheck {
  private readonly driftAnalyzer: DriftAnalyzer;
  private readonly consistencyChecker: ConsistencyChecker;
  private readonly securityAnalyzer: SecurityAnalyzer;
  private readonly planQualityEvaluator: PlanQualityEvaluator;
  private readonly reasoningValidator: ReasoningValidator;
  private readonly metricsStore: MetricsStore | null;
  private readonly fs: IFileSystem | null;
  private readonly substratePath: string | null;

  constructor(
    reader: SubstrateFileReader,
    metricsStore: MetricsStore | null = null,
    fs: IFileSystem | null = null,
    substratePath: string | null = null,
  ) {
    this.driftAnalyzer = new DriftAnalyzer(reader);
    this.consistencyChecker = new ConsistencyChecker(reader);
    this.securityAnalyzer = new SecurityAnalyzer(reader);
    this.planQualityEvaluator = new PlanQualityEvaluator(reader);
    this.reasoningValidator = new ReasoningValidator(reader);
    this.metricsStore = metricsStore;
    this.fs = fs;
    this.substratePath = substratePath;
  }

  /**
   * Lightweight critical health check for the supervisor's post-restart validation.
   * Returns structured result including substrate file writability.
   */
  async runCriticalChecks(): Promise<CriticalChecksResult> {
    let readsOk = false;
    try {
      const [drift, consistency] = await Promise.all([
        this.driftAnalyzer.analyze(),
        this.consistencyChecker.check(),
      ]);
      readsOk = drift !== null && consistency !== null;
    } catch {
      readsOk = false;
    }

    let substrateFsWritable: "healthy" | "unhealthy" = "unhealthy";
    if (this.fs && this.substratePath) {
      const tmpPath = `${this.substratePath}/.health-check-tmp`;
      try {
        await this.fs.writeFile(tmpPath, "health-check");
        await this.fs.unlink(tmpPath);
        substrateFsWritable = "healthy";
      } catch {
        substrateFsWritable = "unhealthy";
      }
    } else {
      // Fall back to read success as proxy when no fs provided
      substrateFsWritable = readsOk ? "healthy" : "unhealthy";
    }

    return { healthy: readsOk && substrateFsWritable === "healthy", substrateFsWritable };
  }

  async run(): Promise<HealthCheckResult> {
    const [drift, consistency, security, planQuality, reasoning] = await Promise.all([
      this.driftAnalyzer.analyze(),
      this.consistencyChecker.check(),
      this.securityAnalyzer.analyze(),
      this.planQualityEvaluator.evaluate(),
      this.reasoningValidator.validate(),
    ]);

    const overall = this.determineOverall(drift, consistency, security, planQuality, reasoning);

    // Record metrics and analyze trends if MetricsStore is available
    let trends: TrendAnalysis | undefined;
    if (this.metricsStore) {
      await this.metricsStore.record({
        driftScore: drift.score,
        consistencyScore: consistency.score,
        securityScore: security.score,
      });

      trends = await this.metricsStore.analyzeTrends();
    }

    return { overall, drift, consistency, security, planQuality, reasoning, trends };
  }

  private determineOverall(
    drift: DriftResult,
    consistency: ConsistencyResult,
    security: SecurityResult,
    planQuality: PlanQualityResult,
    reasoning: ReasoningResult
  ): "healthy" | "degraded" | "unhealthy" {
    const issues =
      (drift.score > 0.5 ? 1 : 0) +
      (consistency.score < 0.75 ? 1 : 0) + // Use quantitative score
      (security.score < 0.75 ? 1 : 0) + // Use quantitative score
      (planQuality.score < 0.5 ? 1 : 0) +
      (!reasoning.valid ? 1 : 0);

    if (issues === 0) return "healthy";
    if (issues <= 2) return "degraded";
    return "unhealthy";
  }
}
