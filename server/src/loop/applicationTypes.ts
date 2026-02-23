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
  /** Maximum duration (ms) for a single conversation session. Prevents runaway sessions from blocking cycles.
   *  Default: 300000 (5 minutes). Set to 0 to disable. */
  conversationSessionMaxDurationMs?: number;
  abandonedProcessGraceMs?: number; // Default: 600000 (10 min)
  idleSleepConfig?: {
    enabled: boolean; // Whether to enable idle sleep (default: false)
    idleCyclesBeforeSleep: number; // Number of consecutive idle cycles before sleeping (default: 5)
  };
  /** Shutdown grace period in milliseconds (default: 5000). Active sessions receive a shutdown notice before force-kill. */
  shutdownGraceMs?: number;
  /** Log verbosity level (default: "info"). Use "debug" to log full envelope payloads and session content. */
  logLevel?: "info" | "debug";
  /** When set, all /api/* and /mcp requests must include Authorization: Bearer <apiToken> */
  apiToken?: string;
  /** Configuration for the loop watchdog that detects stalls and injects reminders */
  watchdog?: {
    /** Disable the watchdog entirely (default: false) */
    disabled?: boolean;
    /** Milliseconds without activity before stall reminder is injected (default: 1200000 — 20 min) */
    stallThresholdMs?: number;
    /** Milliseconds between watchdog checks (default: 300000 — 5 min) */
    checkIntervalMs?: number;
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
