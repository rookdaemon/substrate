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
  const defaults: LoopConfig = {
    cycleDelayMs: 30000,
    superegoAuditInterval: 20,
    maxConsecutiveIdleCycles: 1,
  };
  if (!overrides) return defaults;
  return {
    cycleDelayMs: overrides.cycleDelayMs ?? defaults.cycleDelayMs,
    superegoAuditInterval: overrides.superegoAuditInterval ?? defaults.superegoAuditInterval,
    maxConsecutiveIdleCycles: overrides.maxConsecutiveIdleCycles ?? defaults.maxConsecutiveIdleCycles,
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

export interface TickResult {
  tickNumber: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface LoopEvent {
  type: "state_changed" | "cycle_complete" | "idle" | "error" | "audit_complete" | "idle_handler" | "evaluation_requested" | "process_output" | "conversation_message" | "conversation_response" | "tick_started" | "tick_complete" | "message_injected" | "restart_requested" | "backup_complete" | "health_check_complete" | "email_sent" | "metrics_collected" | "reconsideration_complete" | "agora_message" | "file_changed";
  timestamp: string;
  data: Record<string, unknown>;
}
