export enum LoopState {
  STOPPED = "STOPPED",
  RUNNING = "RUNNING",
  PAUSED = "PAUSED",
  SLEEPING = "SLEEPING",
}

export interface LoopConfig {
  cycleDelayMs: number;
  superegoAuditInterval: number;
  maxConsecutiveIdleCycles: number;
  idleSleepEnabled: boolean;
  evaluateOutcomeEnabled: boolean;
  evaluateOutcomeQualityThreshold: number;
}

export function defaultLoopConfig(overrides?: Partial<LoopConfig>): LoopConfig {
  const defaults: LoopConfig = {
    cycleDelayMs: 30000,
    superegoAuditInterval: 50,
    maxConsecutiveIdleCycles: 1,
    idleSleepEnabled: false,
    evaluateOutcomeEnabled: false,
    evaluateOutcomeQualityThreshold: 70,
  };
  if (!overrides) return defaults;
  return {
    cycleDelayMs: overrides.cycleDelayMs ?? defaults.cycleDelayMs,
    superegoAuditInterval: overrides.superegoAuditInterval ?? defaults.superegoAuditInterval,
    maxConsecutiveIdleCycles: overrides.maxConsecutiveIdleCycles ?? defaults.maxConsecutiveIdleCycles,
    idleSleepEnabled: overrides.idleSleepEnabled ?? defaults.idleSleepEnabled,
    evaluateOutcomeEnabled: overrides.evaluateOutcomeEnabled ?? defaults.evaluateOutcomeEnabled,
    evaluateOutcomeQualityThreshold: overrides.evaluateOutcomeQualityThreshold ?? defaults.evaluateOutcomeQualityThreshold,
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
  consecutiveAuditFailures: number;
}

export function createInitialMetrics(): LoopMetrics {
  return {
    totalCycles: 0,
    successfulCycles: 0,
    failedCycles: 0,
    idleCycles: 0,
    consecutiveIdleCycles: 0,
    superegoAudits: 0,
    consecutiveAuditFailures: 0,
  };
}

export interface TickResult {
  tickNumber: number;
  success: boolean;
  durationMs: number;
  error?: string;
}

export interface LoopEvent {
  type: "state_changed" | "cycle_complete" | "idle" | "error" | "audit_complete" | "idle_handler" | "evaluation_requested" | "process_output" | "conversation_message" | "conversation_response" | "tick_started" | "tick_complete" | "message_injected" | "message_processing_started" | "restart_requested" | "backup_complete" | "health_check_complete" | "email_sent" | "metrics_collected" | "reconsideration_complete" | "agora_message" | "file_changed" | "validation_complete";
  timestamp: string;
  data: Record<string, unknown>;
}
