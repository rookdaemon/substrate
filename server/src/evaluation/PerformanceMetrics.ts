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

/**
 * TinyBus message event — recorded for each message routed through TinyBus (#223).
 */
export interface TinyBusMessageEvent {
  timestamp: string; // ISO 8601
  eventType: "tinybus_message";
  durationMs: number;
  metadata: {
    messageType: string;     // e.g. "agora.send", "chat"
    source: string;
    destination?: string;
    routedTo: number;        // count of providers that received message
    success: boolean;
  };
}

export type PerformanceEvent = CycleEvent | ApiCallEvent | SubstrateIoEvent | TinyBusMessageEvent;

/**
 * Persists granular performance events to `.metrics/performance.jsonl`.
 *
 * Design decisions:
 * - JSONL append-only — efficient for high-frequency writes, human-readable
 * - Best-effort writes — never throws; metrics must not interrupt the loop
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

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    substratePath: string,
  ) {
    this.metricsDir = path.join(substratePath, ".metrics");
    this.metricsPath = path.join(this.metricsDir, "performance.jsonl");
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
   * Record a TinyBus message routing event (#223).
   * Called via the message.complete event listener wired in createLoopLayer.
   */
  async recordTinyBusMessage(
    durationMs: number,
    messageType: string,
    source: string,
    routedTo: number,
    success: boolean,
    destination?: string,
  ): Promise<void> {
    const event: TinyBusMessageEvent = {
      timestamp: this.clock.now().toISOString(),
      eventType: "tinybus_message",
      durationMs,
      metadata: { messageType, source, destination, routedTo, success },
    };
    await this.append(event);
  }

  /**
   * Read all events from the JSONL file (for analysis/reporting).
   * Returns empty array if file doesn't exist or is unreadable.
   */
  async readEvents(): Promise<PerformanceEvent[]> {
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
   * Append a single event to the JSONL file. Best-effort — never throws.
   */
  private async append(event: PerformanceEvent): Promise<void> {
    try {
      await this.ensureDir();
      await this.fs.appendFile(this.metricsPath, JSON.stringify(event) + "\n");
    } catch {
      // Best-effort — performance metrics must never interrupt the loop
    }
  }

  private async ensureDir(): Promise<void> {
    if (!this.dirEnsured) {
      await this.fs.mkdir(this.metricsDir, { recursive: true });
      this.dirEnsured = true;
    }
  }
}
