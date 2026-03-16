import * as path from "node:path";
import { z } from "zod";
import type { IEnvironment } from "./substrate/abstractions/IEnvironment";
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";
import type { AppPaths } from "./paths";

export class ConfigValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ConfigValidationError";
  }
}

const DEFAULT_SESSION_LAUNCHER = "claude" as const;

export interface ProviderModelsConfig {
  model?: string;
  strategicModel?: string;
  tacticalModel?: string;
}

const ProviderModelsSchema = z.object({
  model: z.string().optional(),
  strategicModel: z.string().optional(),
  tacticalModel: z.string().optional(),
});

const AppConfigSchema = z
  .object({
    substratePath: z.string(),
    workingDirectory: z.string(),
    sourceCodePath: z.string(),
    backupPath: z.string(),
    port: z.number().int().min(1).max(65535),
    model: z.string(),
    strategicModel: z.string().optional(),
    tacticalModel: z.string().optional(),
    models: z.record(z.string(), ProviderModelsSchema).optional(),
    mode: z.enum(["cycle", "tick"]),
    autoStartOnFirstRun: z.boolean(),
    autoStartAfterRestart: z.boolean(),
    backupRetentionCount: z.number().int().min(1).optional(),
    superegoAuditInterval: z.number().int().min(1).optional(),
    evaluateOutcome: z
      .object({
        enabled: z.boolean(),
        qualityThreshold: z.number().min(0).max(100).optional(),
      })
      .optional(),
    cycleDelayMs: z.number().min(0).optional(),
    conversationIdleTimeoutMs: z.number().min(0).optional(),
    conversationArchive: z
      .object({
        enabled: z.boolean(),
        linesToKeep: z.number().int().min(1),
        sizeThreshold: z.number().int().min(1),
        timeThresholdDays: z.number().int().min(1).optional(),
      })
      .optional(),
    email: z
      .object({
        enabled: z.boolean(),
        intervalHours: z.number().min(1),
        sendTimeHour: z.number().int().min(0).max(23),
        sendTimeMinute: z.number().int().min(0).max(59),
      })
      .optional(),
    agora: z
      .object({
        security: z
          .object({
            perSenderRateLimit: z
              .object({
                enabled: z.boolean(),
                maxMessages: z.number().int().min(1),
                windowMs: z.number().min(1),
              })
              .optional(),
          })
          .optional(),
      })
      .optional(),
    idleSleepConfig: z
      .object({
        enabled: z.boolean(),
        idleCyclesBeforeSleep: z.number().int().min(1),
      })
      .optional(),
    shutdownGraceMs: z.number().min(0).optional(),
    logLevel: z.enum(["info", "debug"]).optional(),
    apiToken: z.string().optional(),
    enableFileReadCache: z.boolean().optional(),
    progressMaxBytes: z.number().int().min(1).optional(),
    sessionLauncher: z.enum(["claude", "gemini", "copilot", "ollama", "vertex"]).optional(),
    ollamaBaseUrl: z.string().url().optional(),
    ollamaModel: z.string().optional(),
    defaultCodeBackend: z.enum(["claude", "copilot", "gemini", "auto"]).optional(),
    ollamaOffload: z
      .object({
        enabled: z.boolean(),
      })
      .optional(),
    vertexKeyPath: z.string().optional(),
    vertexModel: z.string().optional(),
    idLauncher: z.enum(["claude", "vertex", "ollama"]).optional(),
    idOllamaModel: z.string().optional(),
    peers: z
      .array(z.object({ name: z.string(), port: z.number().int().min(1).max(65535) }))
      .optional(),
    schedulerCoalesceEnabled: z.boolean().optional(),
  })
  .refine(
    (data) =>
      data.cycleDelayMs === undefined ||
      data.conversationIdleTimeoutMs === undefined ||
      data.cycleDelayMs > data.conversationIdleTimeoutMs,
    {
      message: "cycleDelayMs must be greater than conversationIdleTimeoutMs",
      path: ["cycleDelayMs"],
    }
  )
  .refine(
    (data) => data.sessionLauncher !== "vertex",
    {
      message: "sessionLauncher: \"vertex\" is not allowed for cognitive roles. Vertex is for subprocess tasks only (compaction, summarization). Use vertexKeyPath to enable it as a subprocess fallback.",
      path: ["sessionLauncher"],
    }
  )
  .refine(
    (data) => data.idLauncher !== "vertex" || !!data.vertexKeyPath,
    {
      message: "idLauncher: \"vertex\" requires vertexKeyPath to be set.",
      path: ["idLauncher"],
    }
  );

function isEnvironment(
  fsOrEnv: IFileSystem | IEnvironment
): fsOrEnv is IEnvironment {
  return typeof (fsOrEnv as IEnvironment).getEnv === "function";
}

/** Use posix path join when path looks like a posix path (e.g. test or Unix). */
function pathJoin(base: string, ...segments: string[]): string {
  if (base.startsWith("/") && !base.match(/^[a-zA-Z]:/)) {
    return path.posix.join(base, ...segments);
  }
  return path.join(base, ...segments);
}

/**
 * Resolves the effective model, strategicModel, and tacticalModel from file config.
 *
 * Resolution order (highest priority first):
 *   1. models[sessionLauncher] — per-provider model config block
 *   2. Legacy flat model/strategicModel/tacticalModel fields
 *   3. Defaults
 */
function resolveModelFields(
  fileConfig: Partial<AppConfig>,
  defaults: AppConfig
): { model: string; strategicModel?: string; tacticalModel?: string } {
  const launcher = fileConfig.sessionLauncher ?? defaults.sessionLauncher ?? DEFAULT_SESSION_LAUNCHER;
  const providerModels = fileConfig.models?.[launcher];

  return {
    model: providerModels?.model ?? fileConfig.model ?? defaults.model,
    strategicModel: providerModels?.strategicModel ?? fileConfig.strategicModel ?? defaults.strategicModel,
    tacticalModel: providerModels?.tacticalModel ?? fileConfig.tacticalModel ?? defaults.tacticalModel,
  };
}

export interface AppConfig {
  substratePath: string;
  workingDirectory: string;
  sourceCodePath: string;
  backupPath: string;
  port: number;
  model: string;
  strategicModel?: string;
  tacticalModel?: string;
  /** Per-provider model configuration. Keys match sessionLauncher/defaultCodeBackend values (e.g. "claude", "gemini", "copilot"). */
  models?: Record<string, ProviderModelsConfig>;
  mode: "cycle" | "tick";
  /** If true, the agent loop auto-starts on first/cold start (default: false — you often want to be there). */
  autoStartOnFirstRun: boolean;
  /** If true (default), the agent loop auto-starts when the server was restarted (e.g. after Restart button or rebuild). */
  autoStartAfterRestart: boolean;
  /** Number of backups to retain (default: 14). */
  backupRetentionCount?: number;
  /** Number of cycles between SUPEREGO audits (default: 50). Can be overridden by SUPEREGO_AUDIT_INTERVAL env var. */
  superegoAuditInterval?: number;
  /** Configuration for post-task outcome evaluation */
  evaluateOutcome?: {
    /** When false (default), use computeDriveRating() heuristic; fall back to LLM only when score < qualityThreshold */
    enabled: boolean;
    /** Minimum heuristic quality score (0-100) required to skip LLM evaluation (default: 70) */
    qualityThreshold?: number;
  };
  /** Delay between loop cycles in ms (default: 30000). For primarily reactive agents, consider 60000 or more. */
  cycleDelayMs?: number;
  /** How long (ms) a conversation session stays open after the last message before being closed (default: 20000). */
  conversationIdleTimeoutMs?: number;
  /** Maximum duration (ms) for a single conversation session. Prevents runaway sessions from blocking cycles.
   *  Default: 300000 (5 minutes). Set to 0 to disable. */
  conversationSessionMaxDurationMs?: number;
  /** Configuration for CONVERSATION.md archiving */
  conversationArchive?: {
    enabled: boolean;
    linesToKeep: number; // Number of recent lines to keep (default: 100)
    sizeThreshold: number; // Archive when content exceeds N lines (default: 200)
    timeThresholdDays?: number; // Optional: archive after N days (e.g., 7 for weekly)
  };
  /** Configuration for scheduled emails */
  email?: {
    enabled: boolean; // Whether to send scheduled emails (default: false)
    intervalHours: number; // How often to send emails in hours (default: 24 for daily)
    sendTimeHour: number; // Hour of day to send email in CET/CEST (0-23, default: 5 for 5am)
    sendTimeMinute: number; // Minute of hour to send email (0-59, default: 0)
  };
  /** Configuration for Agora security */
  agora?: {
    security?: {
      /** Policy for messages from senders not in PEERS.md (default: 'quarantine') */
      unknownSenderPolicy?: 'allow' | 'quarantine' | 'reject';
      perSenderRateLimit?: {
        enabled: boolean; // Whether to enable per-sender rate limiting (default: true)
        maxMessages: number; // Maximum messages per sender in time window (default: 10)
        windowMs: number; // Time window in milliseconds (default: 60000 - 1 minute)
      };
    };
  };
  /** Configuration for idle sleep (reduces token burn when idle) */
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
  /** Which session launcher to use for agent reasoning sessions (default: "claude").
   *  "vertex" is NOT allowed here — Vertex is for subprocess tasks only. Use vertexKeyPath instead. */
  sessionLauncher?: "claude" | "gemini" | "copilot" | "ollama";
  /** Base URL for the Ollama server when sessionLauncher is "ollama" (default: "http://localhost:11434"). */
  ollamaBaseUrl?: string;
  /** Model name for Ollama when sessionLauncher is "ollama" (default: "qwen3:14b"). Separate from `model` which is the Claude/Gemini model name. */
  ollamaModel?: string;
  /** Default code backend to use for code dispatch tasks (default: "claude"). */
  defaultCodeBackend?: "claude" | "copilot" | "gemini" | "auto";
  /** Configuration for Ollama offload — offloads maintenance tasks (compaction) to local Ollama.
   *  Uses ollamaBaseUrl/ollamaModel for endpoint config. Works regardless of sessionLauncher setting. */
  ollamaOffload?: {
    /** When true, ConversationCompactor tries Ollama first for summarization, falls back to primary launcher. */
    enabled: boolean;
  };
  /** Path to Google AI API key file for Vertex subprocess fallback.
   *  When set, VertexSessionLauncher is created as a middle-tier fallback between Ollama and Claude
   *  for subprocess tasks (compaction, summarization). Never logged (path or contents). */
  vertexKeyPath?: string;
  /** Model name for Vertex subprocess tasks (default: "gemini-2.5-flash"). */
  vertexModel?: string;
  /** Which session launcher to use for the Id cognitive role (default: "claude" — same as other roles).
   *  Set to "vertex" to route Id through VertexSessionLauncher. Requires vertexKeyPath to be set.
   *  Set to "ollama" to route Id through OllamaSessionLauncher. Uses ollamaBaseUrl and idOllamaModel (falls back to ollamaModel). */
  idLauncher?: "claude" | "vertex" | "ollama";
  /** Model name for Ollama when idLauncher is "ollama" (default: falls back to ollamaModel, then OllamaSessionLauncher built-in default "qwen3:14b").
   *  Separate from ollamaModel to allow independent model selection per role. */
  idOllamaModel?: string;
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
  /**
   * When true (default), LLM-invoking schedulers (HealthCheck, Metrics) are deferred
   * to the next cycle if a cognitive role already started an LLM session this cycle.
   * Set to false to disable the constraint and allow multiple LLM sessions per cycle.
   */
  schedulerCoalesceEnabled?: boolean;
}

export interface ResolveConfigOptions {
  appPaths: AppPaths;
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function resolveConfig(
  fsOrEnv: IFileSystem | IEnvironment,
  options: ResolveConfigOptions
): Promise<AppConfig> {
  const fs = isEnvironment(fsOrEnv) ? fsOrEnv.fs : fsOrEnv;
  const env = options.env ?? (isEnvironment(fsOrEnv) ? (key: string) => fsOrEnv.getEnv(key) : undefined);
  const { appPaths } = options;

  const defaults: AppConfig = {
    substratePath: appPaths.data,
    workingDirectory: appPaths.data,
    sourceCodePath: options.cwd ?? appPaths.data,
    backupPath:
      appPaths.data.startsWith("/") && !/^[a-zA-Z]:/.test(appPaths.data)
        ? path.posix.join(path.posix.dirname(appPaths.data), "substrate-backups")
        : path.join(path.dirname(appPaths.data), "substrate-backups"),
    port: 3000,
    model: "sonnet",
    strategicModel: "opus",
    tacticalModel: "sonnet",
    mode: "cycle",
    autoStartOnFirstRun: true,
    autoStartAfterRestart: true,
    backupRetentionCount: 14,
    superegoAuditInterval: 50,
    cycleDelayMs: 30000,
    evaluateOutcome: {
      enabled: false,
      qualityThreshold: 85,
    },
    conversationIdleTimeoutMs: 20000,
    conversationSessionMaxDurationMs: 300_000,
    conversationArchive: {
      enabled: false, // Disabled by default to maintain backward compatibility
      linesToKeep: 100,
      sizeThreshold: 200,
      timeThresholdDays: 7, // Weekly by default
    },
    email: {
      enabled: false, // Disabled by default
      intervalHours: 24, // Daily by default
      sendTimeHour: 5, // 5am CET/CEST
      sendTimeMinute: 0,
    },
    agora: {
      security: {
        perSenderRateLimit: {
          enabled: true, // Enabled by default
          maxMessages: 10, // 10 messages per minute
          windowMs: 60000, // 1 minute window
        },
      },
    },
    shutdownGraceMs: 5000,
    logLevel: "info",
    progressMaxBytes: 512 * 1024,
    sessionLauncher: "claude",
    defaultCodeBackend: "auto",
  };

  let fileConfig: Partial<AppConfig> = {};

  if (options.configPath) {
    if (!(await fs.exists(options.configPath))) {
      throw new Error(`Config file not found: ${options.configPath}`);
    }
    const raw = await fs.readFile(options.configPath);
    fileConfig = JSON.parse(raw) as Partial<AppConfig>;
  } else {
    // Try CWD config.json
    const cwdConfig = options.cwd ? pathJoin(options.cwd, "config.json") : undefined;
    if (cwdConfig && await fs.exists(cwdConfig)) {
      const raw = await fs.readFile(cwdConfig);
      fileConfig = JSON.parse(raw) as Partial<AppConfig>;
    } else {
      // Try config-dir config.json
      const configDirFile = pathJoin(appPaths.config, "config.json");
      if (await fs.exists(configDirFile)) {
        const raw = await fs.readFile(configDirFile);
        fileConfig = JSON.parse(raw) as Partial<AppConfig>;
      }
    }
  }

  const merged: AppConfig = {
    substratePath: fileConfig.substratePath ?? defaults.substratePath,
    workingDirectory: fileConfig.workingDirectory ?? defaults.workingDirectory,
    sourceCodePath: fileConfig.sourceCodePath ?? defaults.sourceCodePath,
    backupPath: fileConfig.backupPath ?? defaults.backupPath,
    port: fileConfig.port ?? defaults.port,
    ...resolveModelFields(fileConfig, defaults),
    models: fileConfig.models,
    mode: (fileConfig as Partial<AppConfig>).mode ?? defaults.mode,
    autoStartOnFirstRun: fileConfig.autoStartOnFirstRun ?? defaults.autoStartOnFirstRun,
    autoStartAfterRestart: fileConfig.autoStartAfterRestart ?? defaults.autoStartAfterRestart,
    backupRetentionCount: fileConfig.backupRetentionCount ?? defaults.backupRetentionCount,
    superegoAuditInterval: fileConfig.superegoAuditInterval ?? defaults.superegoAuditInterval,
    cycleDelayMs: fileConfig.cycleDelayMs ?? defaults.cycleDelayMs,
    evaluateOutcome: fileConfig.evaluateOutcome
      ? {
        enabled: fileConfig.evaluateOutcome.enabled ?? defaults.evaluateOutcome!.enabled,
        qualityThreshold: fileConfig.evaluateOutcome.qualityThreshold ?? defaults.evaluateOutcome!.qualityThreshold,
      }
      : defaults.evaluateOutcome,
    conversationIdleTimeoutMs: fileConfig.conversationIdleTimeoutMs ?? defaults.conversationIdleTimeoutMs,
    conversationSessionMaxDurationMs: fileConfig.conversationSessionMaxDurationMs ?? defaults.conversationSessionMaxDurationMs,
    conversationArchive: fileConfig.conversationArchive
      ? {
        enabled: fileConfig.conversationArchive.enabled ?? defaults.conversationArchive!.enabled,
        linesToKeep: fileConfig.conversationArchive.linesToKeep ?? defaults.conversationArchive!.linesToKeep,
        sizeThreshold: fileConfig.conversationArchive.sizeThreshold ?? defaults.conversationArchive!.sizeThreshold,
        timeThresholdDays: fileConfig.conversationArchive.timeThresholdDays ?? defaults.conversationArchive!.timeThresholdDays,
      }
      : defaults.conversationArchive,
    email: fileConfig.email
      ? {
        enabled: fileConfig.email.enabled ?? defaults.email!.enabled,
        intervalHours: fileConfig.email.intervalHours ?? defaults.email!.intervalHours,
        sendTimeHour: fileConfig.email.sendTimeHour ?? defaults.email!.sendTimeHour,
        sendTimeMinute: fileConfig.email.sendTimeMinute ?? defaults.email!.sendTimeMinute,
      }
      : defaults.email,
    agora: fileConfig.agora
      ? {
        security: fileConfig.agora.security
          ? {
            unknownSenderPolicy: fileConfig.agora.security.unknownSenderPolicy ?? 'quarantine',
            perSenderRateLimit: fileConfig.agora.security.perSenderRateLimit
              ? {
                enabled: fileConfig.agora.security.perSenderRateLimit.enabled ?? defaults.agora!.security!.perSenderRateLimit!.enabled,
                maxMessages: fileConfig.agora.security.perSenderRateLimit.maxMessages ?? defaults.agora!.security!.perSenderRateLimit!.maxMessages,
                windowMs: fileConfig.agora.security.perSenderRateLimit.windowMs ?? defaults.agora!.security!.perSenderRateLimit!.windowMs,
              }
              : defaults.agora!.security!.perSenderRateLimit,
          }
          : defaults.agora!.security,
      }
      : defaults.agora,
    idleSleepConfig: fileConfig.idleSleepConfig
      ? {
        enabled: fileConfig.idleSleepConfig.enabled ?? false,
        idleCyclesBeforeSleep: fileConfig.idleSleepConfig.idleCyclesBeforeSleep ?? 5,
      }
      : undefined,
    shutdownGraceMs: fileConfig.shutdownGraceMs ?? defaults.shutdownGraceMs,
    logLevel: (fileConfig.logLevel ?? defaults.logLevel) as "info" | "debug",
    apiToken: fileConfig.apiToken,
    enableFileReadCache: fileConfig.enableFileReadCache,
    progressMaxBytes: fileConfig.progressMaxBytes ?? defaults.progressMaxBytes,
    sessionLauncher: fileConfig.sessionLauncher ?? defaults.sessionLauncher,
    ollamaBaseUrl: fileConfig.ollamaBaseUrl,
    ollamaModel: fileConfig.ollamaModel,
    defaultCodeBackend: fileConfig.defaultCodeBackend ?? defaults.defaultCodeBackend,
    ollamaOffload: fileConfig.ollamaOffload
      ? {
        enabled: fileConfig.ollamaOffload.enabled ?? false,
      }
      : undefined,
    vertexKeyPath: fileConfig.vertexKeyPath,
    vertexModel: fileConfig.vertexModel,
    idLauncher: fileConfig.idLauncher,
    idOllamaModel: fileConfig.idOllamaModel,
    watchdog: fileConfig.watchdog
      ? {
        disabled: fileConfig.watchdog.disabled ?? false,
        stallThresholdMs: fileConfig.watchdog.stallThresholdMs ?? 20 * 60 * 1000,
        checkIntervalMs: fileConfig.watchdog.checkIntervalMs ?? 5 * 60 * 1000,
        forceRestartThresholdMs: fileConfig.watchdog.forceRestartThresholdMs ?? 10 * 60 * 1000,
      }
      : undefined,
    peers: fileConfig.peers,
  };

  // Env vars override everything
  const getEnv = typeof env === "function" ? env : (k: string) => env[k];
  if (getEnv("SUBSTRATE_PATH")) {
    merged.substratePath = getEnv("SUBSTRATE_PATH")!;
  }
  if (getEnv("PORT")) {
    merged.port = parseInt(getEnv("PORT")!, 10);
  }
  if (getEnv("SUPEREGO_AUDIT_INTERVAL")) {
    merged.superegoAuditInterval = parseInt(getEnv("SUPEREGO_AUDIT_INTERVAL")!, 10);
  }

  try {
    AppConfigSchema.parse(merged);
  } catch (err) {
    if (err instanceof z.ZodError) {
      const details = err.issues
        .map((issue) => `${issue.path.join(".") || "(root)"} — ${issue.message}`)
        .join("; ");
      throw new ConfigValidationError(`Invalid config.json: ${details}`);
    }
    throw err;
  }

  return merged;
}
