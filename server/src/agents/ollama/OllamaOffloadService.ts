import type { IOllamaInferenceClient } from "./OllamaInferenceClient";
import type { IClock } from "../../substrate/abstractions/IClock";
import type { ILogger } from "../../logging";

/**
 * Task types that can be offloaded to Ollama.
 * Phase 1: conversation compaction only.
 */
export type OffloadTaskType = "compaction";

export interface OffloadTask {
  taskType: OffloadTaskType;
  input: string;
  qualityGate: (result: string) => boolean;
}

export type OffloadResult =
  | { ok: true; result: string }
  | { ok: false; reason: "unavailable" | "quality_fail" | "parse_error" };

/**
 * In-memory availability state for the Ollama endpoint.
 * Tracks consecutive failures and implements backoff polling.
 */
interface AvailabilityState {
  lastStatus: "available" | "unavailable" | "unknown";
  consecutiveFailures: number;
  callsSinceLastAttempt: number;
}

/**
 * OllamaOffloadService — orchestrates selective task offloading to Ollama.
 *
 * Key invariants:
 * - offload() NEVER throws. Always returns OffloadResult.
 * - After 3 consecutive failures, backs off to polling every 3rd call.
 * - Recovery probe (GET /api/tags) before real inference after backoff.
 * - Quality gate validates output before returning success.
 *
 * Phase 1 scope: conversation compaction only.
 */
export class OllamaOffloadService {
  private state: AvailabilityState = {
    lastStatus: "unknown",
    consecutiveFailures: 0,
    callsSinceLastAttempt: 0,
  };

  private static readonly BACKOFF_THRESHOLD = 3;
  private static readonly BACKOFF_INTERVAL = 3;

  constructor(
    private readonly client: IOllamaInferenceClient,
    private readonly clock: IClock,
    private readonly logger: ILogger,
  ) {}

  /**
   * Attempt to offload a task to Ollama.
   * Returns the result if successful, or a typed failure reason.
   */
  async offload(task: OffloadTask): Promise<OffloadResult> {
    try {
      // Backoff check: if in backoff mode, skip unless interval elapsed
      if (this.isInBackoff()) {
        this.state.callsSinceLastAttempt++;
        if (this.state.callsSinceLastAttempt < OllamaOffloadService.BACKOFF_INTERVAL) {
          this.logger.debug(
            `[OLLAMA-OFFLOAD] Skipping — backoff active (${this.state.callsSinceLastAttempt}/${OllamaOffloadService.BACKOFF_INTERVAL})`
          );
          return { ok: false, reason: "unavailable" };
        }
        // Interval elapsed — reset counter and attempt recovery probe
        this.state.callsSinceLastAttempt = 0;
        this.logger.debug("[OLLAMA-OFFLOAD] Backoff interval elapsed — attempting recovery probe");
        const probeOk = await this.client.probe();
        if (!probeOk) {
          this.logger.debug("[OLLAMA-OFFLOAD] Recovery probe failed — still unavailable");
          this.state.consecutiveFailures++;
          return { ok: false, reason: "unavailable" };
        }
        this.logger.debug("[OLLAMA-OFFLOAD] Recovery probe succeeded — attempting inference");
      }

      // Attempt inference
      const inferenceResult = await this.client.infer(task.input);

      if (!inferenceResult.ok) {
        this.recordFailure(inferenceResult.reason === "parse_error" ? "parse_error" : "unavailable");
        return { ok: false, reason: inferenceResult.reason === "parse_error" ? "parse_error" : "unavailable" };
      }

      // Quality gate
      if (!task.qualityGate(inferenceResult.result)) {
        this.logger.debug("[OLLAMA-OFFLOAD] Quality gate failed for task");
        this.recordFailure("quality_fail");
        return { ok: false, reason: "quality_fail" };
      }

      // Success — reset failure tracking
      this.recordSuccess();
      this.logger.debug(`[OLLAMA-OFFLOAD] Task ${task.taskType} completed successfully`);
      return { ok: true, result: inferenceResult.result };
    } catch (err) {
      // Safety net — offload() must never throw
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`[OLLAMA-OFFLOAD] Unexpected error: ${msg}`);
      this.recordFailure("unavailable");
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * Check if the service is currently in backoff mode.
   */
  isInBackoff(): boolean {
    return this.state.consecutiveFailures >= OllamaOffloadService.BACKOFF_THRESHOLD;
  }

  /**
   * Get current availability state (for diagnostics/metrics).
   */
  getState(): Readonly<AvailabilityState> {
    return { ...this.state };
  }

  private recordFailure(reason: string): void {
    this.state.consecutiveFailures++;
    this.state.lastStatus = "unavailable";
    this.logger.debug(
      `[OLLAMA-OFFLOAD] Failure recorded (${reason}): consecutiveFailures=${this.state.consecutiveFailures}`
    );
  }

  private recordSuccess(): void {
    this.state.consecutiveFailures = 0;
    this.state.callsSinceLastAttempt = 0;
    this.state.lastStatus = "available";
  }
}
