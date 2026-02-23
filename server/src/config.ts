import * as path from "node:path";
import type { IEnvironment } from "./substrate/abstractions/IEnvironment";
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";
import type { AppPaths } from "./paths";

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

export interface AppConfig {
  substratePath: string;
  workingDirectory: string;
  sourceCodePath: string;
  backupPath: string;
  port: number;
  model: string;
  strategicModel?: string;
  tacticalModel?: string;
  mode: "cycle" | "tick";
  /** If true, the agent loop auto-starts on first/cold start (default: false — you often want to be there). */
  autoStartOnFirstRun: boolean;
  /** If true (default), the agent loop auto-starts when the server was restarted (e.g. after Restart button or rebuild). */
  autoStartAfterRestart: boolean;
  /** Number of backups to retain (default: 14). */
  backupRetentionCount?: number;
  /** Number of cycles between SUPEREGO audits (default: 20). Can be overridden by SUPEREGO_AUDIT_INTERVAL env var. */
  superegoAuditInterval?: number;
  /** Delay between loop cycles in ms (default: 30000). For primarily reactive agents, consider 60000 or more. */
  cycleDelayMs?: number;
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
      unknownSenderPolicy?: 'allow' | 'quarantine' | 'reject'; // default: 'quarantine'
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
  /** Log verbosity level (default: "info"). Use "debug" to log full envelope payloads and session content. */
  logLevel?: "info" | "debug";
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
    autoStartOnFirstRun: false,
    autoStartAfterRestart: true,
    backupRetentionCount: 14,
    superegoAuditInterval: 20,
    cycleDelayMs: 30000,
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
        unknownSenderPolicy: 'quarantine', // Quarantine by default for security
        perSenderRateLimit: {
          enabled: true, // Enabled by default
          maxMessages: 10, // 10 messages per minute
          windowMs: 60000, // 1 minute window
        },
      },
    },
    logLevel: "info",
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
    model: fileConfig.model ?? defaults.model,
    strategicModel: fileConfig.strategicModel ?? defaults.strategicModel,
    tacticalModel: fileConfig.tacticalModel ?? defaults.tacticalModel,
    mode: (fileConfig as Partial<AppConfig>).mode ?? defaults.mode,
    autoStartOnFirstRun: fileConfig.autoStartOnFirstRun ?? defaults.autoStartOnFirstRun,
    autoStartAfterRestart: fileConfig.autoStartAfterRestart ?? defaults.autoStartAfterRestart,
    backupRetentionCount: fileConfig.backupRetentionCount ?? defaults.backupRetentionCount,
    superegoAuditInterval: fileConfig.superegoAuditInterval ?? defaults.superegoAuditInterval,
    cycleDelayMs: fileConfig.cycleDelayMs ?? defaults.cycleDelayMs,
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
                unknownSenderPolicy: fileConfig.agora.security.unknownSenderPolicy ?? defaults.agora!.security!.unknownSenderPolicy,
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
    logLevel: (fileConfig.logLevel ?? defaults.logLevel) as "info" | "debug",
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

  return merged;
}
