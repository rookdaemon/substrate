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
    /**
     * Base URL for the relay REST API used by the wake poller on startup.
     * If omitted, the poller derives the URL from the Agora relay WebSocket URL
     * (replacing ws:// → http:// and wss:// → https://).
     * Set this explicitly when the REST API is on a different host or port.
     */
    relayRestApiUrl?: string;
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
  /** When false, disables the mtime-based file read cache (default: true — cache enabled). */
  enableFileReadCache?: boolean;
  /** Maximum size of PROGRESS.md in bytes before rotation (default: 512 * 1024 = 512 KB). */
  progressMaxBytes?: number;
  /** Maximum concurrent Claude API sessions (default: 2). Prevents rate-limit saturation when work pipeline and conversations overlap. */
  maxConcurrentSessions?: number;
  /** Which session launcher to use for agent reasoning sessions (default: "claude").
   *  NOTE: "groq" uses Groq's free tier (100k tokens/day, 30 req/min) — adequate for Id subprocess
   *  roles but NOT recommended for cyclical cognitive roles (Ego/Subconscious/Superego) which exhaust
   *  the daily token budget in 1-2 active days. Use idLauncher: "groq" for targeted Id use instead. */
  sessionLauncher?: "claude" | "gemini" | "ollama" | "groq";
  /** Base URL for the Ollama server when sessionLauncher is "ollama" (default: "http://localhost:11434"). */
  ollamaBaseUrl?: string;
  /** Model name for Ollama when sessionLauncher is "ollama" (default: "qwen3:14b"). Separate from `model` which is the Claude/Gemini model name. */
  ollamaModel?: string;
  /** Default code backend to use for code dispatch tasks (default: "claude"). */
  defaultCodeBackend?: "claude" | "copilot" | "gemini" | "auto";
  /** Configuration for Ollama offload — offloads maintenance tasks (compaction) to local Ollama.
   *  Uses ollamaBaseUrl/ollamaModel for endpoint config. Works regardless of sessionLauncher setting. */
  ollamaOffload?: {
    /** When true, ConversationCompactor tries Ollama first, falls back to primary launcher. */
    enabled: boolean;
  };
  /** Path to Google AI API key file for Vertex subprocess fallback.
   *  Enables VertexSessionLauncher as a middle-tier fallback between Ollama and Claude
   *  for subprocess tasks (compaction, summarization). Never logged. */
  vertexKeyPath?: string;
  /** Model name for Vertex subprocess tasks (default: "gemini-2.5-flash"). */
  vertexModel?: string;
  /** Path to Groq API key file. Required when sessionLauncher or idLauncher is "groq".
   *  Key is read from this file at startup (never from env vars). Never logged.
   *  Recommended path: ~/.config/substrate/groq.key
   *  Free tier: 100k tokens/day, 30 req/min per key — suited for idLauncher: "groq" (sparse Id use). */
  groqKeyPath?: string;
  /** Which session launcher to use for the Id cognitive role (default: "claude" — same as other roles).
   *  Set to "vertex" to route Id through VertexSessionLauncher. Requires vertexKeyPath to be set.
   *  Set to "ollama" to route Id through OllamaSessionLauncher. Uses ollamaBaseUrl and idOllamaModel (falls back to ollamaModel).
   *  Set to "groq" to route Id through GroqSessionLauncher. Requires groqKeyPath to be set. Uses idGroqModel (falls back to groqModel). */
  idLauncher?: "claude" | "vertex" | "ollama" | "groq";
  /** Model name for Ollama when idLauncher is "ollama" (default: falls back to ollamaModel, then OllamaSessionLauncher built-in default).
   *  Separate from ollamaModel to allow independent model selection for Id. */
  idOllamaModel?: string;
  /** Model name for Groq (default: "llama3-70b-8192"). Used when sessionLauncher is "groq". */
  groqModel?: string;
  /** Model name for Groq when idLauncher is "groq" (default: falls back to groqModel, then GroqSessionLauncher built-in default).
   *  Separate from groqModel to allow independent model selection for Id. */
  idGroqModel?: string;
  /** Configuration for the loop watchdog that detects stalls and injects reminders */
  watchdog?: {
    /** Disable the watchdog entirely (default: false) */
    disabled?: boolean;
    /** Milliseconds without activity before stall reminder is injected (default: 1200000 — 20 min) */
    stallThresholdMs?: number;
    /** Milliseconds between watchdog checks (default: 300000 — 5 min) */
    checkIntervalMs?: number;
    /** Milliseconds after stall reminder before force-restarting the process (default: 600000 — 10 min). Set to 0 to disable force-restart. */
    forceRestartThresholdMs?: number;
  };
  /**
   * Peer substrate instances to monitor for rate-limit availability.
   * On each cycle start, the monitor polls each peer's /api/loop/status endpoint
   * and injects active entries as rateLimitedUntil[peerId].
   */
  peers?: Array<{ name: string; port: number }>;
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
