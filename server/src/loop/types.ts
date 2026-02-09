export enum LoopState {
  STOPPED = "STOPPED",
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
}

export interface LoopConfig {
  cycleDelayMs: number;
  superegoAuditInterval: number;
  maxConsecutiveIdleCycles: number;
}

export function defaultLoopConfig(overrides?: Partial<LoopConfig>): LoopConfig {
  return {
    cycleDelayMs: 1000,
    superegoAuditInterval: 10,
    maxConsecutiveIdleCycles: 5,
    ...overrides,
  };
}

export interface CycleResult {
  cycleNumber: number;
  action: "dispatch" | "idle";
  taskId?: string;
  success: boolean;
  summary: string;
}

export interface LoopMetrics {
  totalCycles: number;
  successfulCycles: number;
  failedCycles: number;
  idleCycles: number;
  consecutiveIdleCycles: number;
  superegoAudits: number;
}

export function createInitialMetrics(): LoopMetrics {
  return {
    totalCycles: 0,
    successfulCycles: 0,
    failedCycles: 0,
    idleCycles: 0,
    consecutiveIdleCycles: 0,
    superegoAudits: 0,
  };
}

export interface LoopEvent {
  type: "state_changed" | "cycle_complete" | "idle" | "error" | "audit_complete" | "idle_handler" | "evaluation_requested" | "process_output";
  timestamp: string;
  data: Record<string, unknown>;
}
