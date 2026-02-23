import type { SdkQueryFn } from "../agents/claude/AgentSdkLauncher";
import type { LoopOrchestrator } from "./LoopOrchestrator";
import type { LoopHttpServer } from "./LoopHttpServer";
import type { LoopWebSocketServer } from "./LoopWebSocketServer";
import type { FileWatcher } from "../substrate/watcher/FileWatcher";

export interface ApplicationConfig {
  substratePath: string;
  workingDirectory?: string;
  sourceCodePath?: string;
  model?: string;
  strategicModel?: string;
  tacticalModel?: string;
  httpPort?: number;
  cycleDelayMs?: number;
  superegoAuditInterval?: number;
  maxConsecutiveIdleCycles?: number;
  mode?: "cycle" | "tick";
  sdkQueryFn?: SdkQueryFn;
  enableBackups?: boolean;
  backupIntervalMs?: number;
  backupRetentionCount?: number;
  enableHealthChecks?: boolean;
  healthCheckIntervalMs?: number;
  conversationArchive?: {
    enabled: boolean;
    linesToKeep: number;
    sizeThreshold: number;
    timeThresholdDays?: number;
  };
  email?: {
    enabled: boolean;
    intervalHours: number;
    sendTimeHour: number;
    sendTimeMinute: number;
  };
  metrics?: {
    enabled: boolean;
    intervalMs?: number; // Default: 604800000 (7 days)
  };
  validation?: {
    enabled?: boolean;
    intervalMs?: number; // Default: 604800000 (7 days)
  };
  agora?: {
    security?: {
      unknownSenderPolicy?: 'allow' | 'quarantine' | 'reject'; // default: 'quarantine'
      perSenderRateLimit?: {
        enabled: boolean;
        maxMessages: number;
        windowMs: number;
      };
    };
  };
  conversationIdleTimeoutMs?: number; // Default: 60000 (60s)
  abandonedProcessGraceMs?: number; // Default: 600000 (10 min)
  idleSleepConfig?: {
    enabled: boolean; // Whether to enable idle sleep (default: false)
    idleCyclesBeforeSleep: number; // Number of consecutive idle cycles before sleeping (default: 5)
  };
}

export interface Application {
  orchestrator: LoopOrchestrator;
  httpServer: LoopHttpServer;
  wsServer: LoopWebSocketServer;
  fileWatcher: FileWatcher;
  logPath: string;
  mode: "cycle" | "tick";
  start(port?: number, forceStart?: boolean): Promise<number>;
  stop(): Promise<void>;
}
