import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import { IClock } from "../substrate/abstractions/IClock";
import * as path from "node:path";

/**
 * Individual cycle completion event — recorded once per executeOneCycle() call.
 */
export interface CycleEvent {
  timestamp: string; // ISO 8601
  eventType: "cycle";
  cycleNumber: number;
  action: "dispatch" | "idle";
  durationMs: number;
  success: boolean;
}

/**
 * API call event — recorded for each agent session (Subconscious.execute(), etc.).
 */
export interface ApiCallEvent {
  timestamp: string; // ISO 8601
  eventType: "api_call";
  durationMs: number;
  metadata: {
    role: string; // e.g. "SUBCONSCIOUS", "EGO"
    operation: string; // e.g. "execute", "dispatchNext"
  };
}

/**
 * Substrate I/O event — recorded for notable file-system operations.
 */
export interface SubstrateIoEvent {
  timestamp: string; // ISO 8601
  eventType: "substrate_io";
  durationMs: number;
  metadata: {
    operation: string; // e.g. "read", "write", "append"
    file: string;
  };
}

export type PerformanceEvent = CycleEvent | ApiCallEvent | SubstrateIoEvent;

/**
 * Persists granular performance events to `.metrics/performance.jsonl`.
 *
 * Design decisions:
 * - JSONL append-only — efficient for high-frequency writes, human-readable
 * - Best-effort writes — never throws; metrics must not interrupt the loop
 * - OPTIMIZATION: Batched writes when buffer reaches size threshold (reduces I/O calls)
 * - Three event types: cycle (per-loop timing), api_call (model call timing),
 *   substrate_io (file I/O timing)
 * - Consumers (Bishop self-analysis) read the JSONL directly to compute stats
 *
 * Integration points:
 * - LoopOrchestrator.executeOneCycle() records cycle events and api_call events
 * - Optional: filesystem wrappers can record substrate_io events
 */
export class PerformanceMetrics {
  private readonly metricsDir: string;
  private readonly metricsPath: string;
  private dirEnsured = false;
  
  // OPTIMIZATION: Event buffer for batched writes (configurable for testing)
  private eventBuffer: PerformanceEvent[] = [];
  private readonly bufferSize: number;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    substratePath: string,
    bufferSize: number = 10, // Batch every 10 events in production
  ) {
    this.metricsDir = path.join(substratePath, ".metrics");
    this.metricsPath = path.join(this.metricsDir, "performance.jsonl");
    this.bufferSize = bufferSize;
  }

  /**
   * Record a completed cycle. Called at the end of LoopOrchestrator.executeOneCycle().
   */
  async recordCycleComplete(
    cycleNumber: number,
    action: "dispatch" | "idle",
    durationMs: number,
    success: boolean,
  ): Promise<void> {
    const event: CycleEvent = {
      timestamp: this.clock.now().toISOString(),
      eventType: "cycle",
      cycleNumber,
      action,
      durationMs,
      success,
    };
    await this.append(event);
  }

  /**
   * Record a single API call (agent session). Called around Subconscious.execute()
   * and other agent operations.
   */
  async recordApiCall(
    durationMs: number,
    role: string,
    operation: string,
  ): Promise<void> {
    const event: ApiCallEvent = {
      timestamp: this.clock.now().toISOString(),
      eventType: "api_call",
      durationMs,
      metadata: { role, operation },
    };
    await this.append(event);
  }

  /**
   * Record a substrate I/O operation. Optional — for notable file operations only.
   */
  async recordSubstrateIo(
    durationMs: number,
    operation: string,
    file: string,
  ): Promise<void> {
    const event: SubstrateIoEvent = {
      timestamp: this.clock.now().toISOString(),
      eventType: "substrate_io",
      durationMs,
      metadata: { operation, file },
    };
    await this.append(event);
  }

  /**
   * Flush any remaining events in the buffer. Call before shutdown or when reading.
   */
  async flush(): Promise<void> {
    await this.flushBuffer();
  }

  /**
   * Read all events from the JSONL file (for analysis/reporting).
   * Returns empty array if file doesn't exist or is unreadable.
   */
  async readEvents(): Promise<PerformanceEvent[]> {
    // Flush buffer before reading to ensure all events are included
    await this.flush();
    
    try {
      const content = await this.fs.readFile(this.metricsPath);
      return content
        .trim()
        .split("\n")
        .filter((line) => line.trim().length > 0)
        .map((line) => JSON.parse(line) as PerformanceEvent);
    } catch {
      return [];
    }
  }

  /**
   * OPTIMIZATION: Add event to buffer and flush when buffer is full.
   * For buffer size > 1, waits until buffer is full before flushing.
   * For buffer size = 1, flushes immediately (backwards compatible with tests).
   */
  private async append(event: PerformanceEvent): Promise<void> {
    this.eventBuffer.push(event);
    
    // Flush immediately if buffer reaches configured size
    if (this.eventBuffer.length >= this.bufferSize) {
      await this.flushBuffer();
    }
    // Note: For bufferSize > 1, events remain buffered until:
    // - Buffer fills up, or
    // - flush() or readEvents() is called explicitly
  }

  private async flushBuffer(): Promise<void> {
    if (this.eventBuffer.length === 0) {
      return;
    }

    try {
      await this.ensureDir();
      
      // Write all buffered events in a single append operation
      const lines = this.eventBuffer.map((event) => JSON.stringify(event)).join("\n") + "\n";
      await this.fs.appendFile(this.metricsPath, lines);
      
      // Clear buffer after successful write
      this.eventBuffer = [];
    } catch {
      // Best-effort — performance metrics must never interrupt the loop
      // Keep events in buffer for next flush attempt
    }
  }

  private async ensureDir(): Promise<void> {
    if (!this.dirEnsured) {
      await this.fs.mkdir(this.metricsDir, { recursive: true });
      this.dirEnsured = true;
    }
  }
}
