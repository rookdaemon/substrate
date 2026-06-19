import { SubstrateFileReader } from "../substrate/io/FileReader";
import { DriftAnalyzer, DriftResult } from "./DriftAnalyzer";
import { ConsistencyChecker, ConsistencyResult } from "./ConsistencyChecker";
import { SecurityAnalyzer, SecurityResult } from "./SecurityAnalyzer";
import { PlanQualityEvaluator, PlanQualityResult } from "./PlanQualityEvaluator";
import { ReasoningValidator, ReasoningResult } from "./ReasoningValidator";
import { MetricsStore, TrendAnalysis } from "./MetricsStore";
import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { InferenceLivenessTracker } from "./InferenceLivenessTracker";
import { OutputQualityMonitor } from "./OutputQualityMonitor";

export interface HealthCheckResult {
  overall: "healthy" | "degraded" | "unhealthy";
  drift: DriftResult;
  consistency: ConsistencyResult;
  security: SecurityResult;
  planQuality: PlanQualityResult;
  reasoning: ReasoningResult;
  trends?: TrendAnalysis; // Optional trend analysis (only available after baseline is established)
  /** Inference path liveness. Omitted if no InferenceLivenessTracker was provided. */
  inference?: {
    observed: boolean;
    alive: boolean;
    consecutiveFailures: number;
    lastError?: string;
  };
}

export interface CriticalChecksResult {
  healthy: boolean;
  substrateFsWritable: "healthy" | "unhealthy";
  /**
   * Inference liveness status.
   * - "healthy": tracker present, at least one attempt observed, and fewer than MAX_INFERENCE_FAILURES consecutive failures.
   * - "degraded": tracker present, at least one attempt observed, and ≥ MAX_INFERENCE_FAILURES consecutive failures.
   * - "unknown": no InferenceLivenessTracker was provided, or a tracker is present but no attempt has been observed yet.
   */
  inferenceAlive: "healthy" | "degraded" | "unknown";
  /**
   * Output quality status (Ego/Subconscious semantic output health).
   * - "healthy": monitor present and fewer than MAX_DEGRADED_CYCLES consecutive degraded cycles.
   * - "degraded": monitor present and ≥ MAX_DEGRADED_CYCLES consecutive degraded cycles.
   * - "unknown": no OutputQualityMonitor was provided.
   *
   * Detects the parse-error storm pattern (e.g. Kimi emitting placeholder ENDORSEMENT_CHECK
   * text → screener can't parse → parse-error ESCALATE repeated for 24+ hours).
   */
  outputQuality: "healthy" | "degraded" | "unknown";
}

/** Inference is considered degraded after this many consecutive failures. */
const MAX_INFERENCE_FAILURES = 3;

/** Output quality is considered degraded after this many consecutive degraded cycles. */
const MAX_DEGRADED_CYCLES = 3;

export class HealthCheck {
  private readonly driftAnalyzer: DriftAnalyzer;
  private readonly consistencyChecker: ConsistencyChecker;
  private readonly securityAnalyzer: SecurityAnalyzer;
  private readonly planQualityEvaluator: PlanQualityEvaluator;
  private readonly reasoningValidator: ReasoningValidator;
  private readonly metricsStore: MetricsStore | null;
  private readonly fs: IFileSystem | null;
  private readonly substratePath: string | null;
  private readonly livenessTracker: InferenceLivenessTracker | null;
  private readonly outputQualityMonitor: OutputQualityMonitor | null;

  constructor(
    reader: SubstrateFileReader,
    metricsStore: MetricsStore | null = null,
    fs: IFileSystem | null = null,
    substratePath: string | null = null,
    livenessTracker?: InferenceLivenessTracker,
    outputQualityMonitor?: OutputQualityMonitor,
  ) {
    this.driftAnalyzer = new DriftAnalyzer(reader);
    this.consistencyChecker = new ConsistencyChecker(reader);
    this.securityAnalyzer = new SecurityAnalyzer(reader);
    this.planQualityEvaluator = new PlanQualityEvaluator(reader);
    this.reasoningValidator = new ReasoningValidator(reader);
    this.metricsStore = metricsStore;
    this.fs = fs;
    this.substratePath = substratePath;
    this.livenessTracker = livenessTracker ?? null;
    this.outputQualityMonitor = outputQualityMonitor ?? null;
  }

  /**
   * Lightweight critical health check for the supervisor's post-restart validation.
   * Returns structured result including substrate file writability and inference liveness.
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

    // Inference liveness — only available when a tracker was wired in.
    const inferenceAlive = this.evaluateInferenceLiveness();

    // Output quality — only available when a monitor was wired in.
    const outputQuality = this.evaluateOutputQuality();

    const healthy =
      readsOk &&
      substrateFsWritable === "healthy" &&
      inferenceAlive !== "degraded" &&
      outputQuality !== "degraded";

    return { healthy, substrateFsWritable, inferenceAlive, outputQuality };
  }

  async run(): Promise<HealthCheckResult> {
    const [drift, consistency, security, planQuality, reasoning] = await Promise.all([
      this.driftAnalyzer.analyze(),
      this.consistencyChecker.check(),
      this.securityAnalyzer.analyze(),
      this.planQualityEvaluator.evaluate(),
      this.reasoningValidator.validate(),
    ]);

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

    // Attach inference liveness state when a tracker is present.
    let inference: HealthCheckResult["inference"];
    const inferenceAlive = this.evaluateInferenceLiveness();
    if (this.livenessTracker) {
      const state = this.livenessTracker.getState();
      inference = {
        observed: state.observed,
        alive: state.alive,
        consecutiveFailures: state.consecutiveFailures,
        lastError: state.lastError,
      };
    }

    const outputQuality = this.evaluateOutputQuality();
    const overall = this.determineOverall(
      drift,
      consistency,
      security,
      planQuality,
      reasoning,
      inferenceAlive,
      outputQuality,
    );

    return { overall, drift, consistency, security, planQuality, reasoning, trends, inference };
  }

  /** Returns whether current non-cached runtime signals are still eligible for a cached healthy result. */
  runtimeSignalsHealthy(): boolean {
    if (this.livenessTracker && this.evaluateInferenceLiveness() !== "healthy") return false;
    if (this.outputQualityMonitor && this.evaluateOutputQuality() !== "healthy") return false;
    return true;
  }

  // ── private helpers ────────────────────────────────────────────────────────

  private evaluateInferenceLiveness(): "healthy" | "degraded" | "unknown" {
    if (!this.livenessTracker) return "unknown";
    // Three-state classification: "degraded" only on confirmed consecutive failures
    // (unchanged supervisor pass/fail), but "unknown" — not a false "healthy" — when
    // the tracker has never proven the inference path (lastSuccessAt === null). Both
    // "healthy" and "unknown" pass runCriticalChecks (only "degraded" fails), so this
    // is honest reporting without changing the restart/rollback decision.
    return this.livenessTracker.getHealthStatus(MAX_INFERENCE_FAILURES);
  }

  private evaluateOutputQuality(): "healthy" | "degraded" | "unknown" {
    if (!this.outputQualityMonitor) return "unknown";
    return this.outputQualityMonitor.isHealthy(MAX_DEGRADED_CYCLES) ? "healthy" : "degraded";
  }

  private determineOverall(
    drift: DriftResult,
    consistency: ConsistencyResult,
    security: SecurityResult,
    planQuality: PlanQualityResult,
    reasoning: ReasoningResult,
    inferenceAlive: "healthy" | "degraded" | "unknown",
    outputQuality: "healthy" | "degraded" | "unknown",
  ): "healthy" | "degraded" | "unhealthy" {
    if (this.livenessTracker && inferenceAlive === "degraded") return "unhealthy";
    if (this.outputQualityMonitor && outputQuality !== "healthy") return "unhealthy";

    const issues =
      (drift.score > 0.5 ? 1 : 0) +
      (consistency.score < 0.75 ? 1 : 0) + // Use quantitative score
      (security.score < 0.75 ? 1 : 0) + // Use quantitative score
      (planQuality.score < 0.5 ? 1 : 0) +
      (!reasoning.valid ? 1 : 0);

    if (issues === 0) {
      return this.livenessTracker && inferenceAlive === "unknown" ? "degraded" : "healthy";
    }
    if (issues <= 2) return "degraded";
    return "unhealthy";
  }
}
