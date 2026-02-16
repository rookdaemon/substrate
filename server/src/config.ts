import * as path from "node:path";
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";
import type { AppPaths } from "./paths";

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
  /** Number of cycles between autonomy reminders (default: 10). Set to 0 to disable. Can be overridden by AUTONOMY_REMINDER_INTERVAL env var. */
  autonomyReminderInterval?: number;
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
}

export interface ResolveConfigOptions {
  appPaths: AppPaths;
  configPath?: string;
  cwd?: string;
  env?: Record<string, string | undefined>;
}

export async function resolveConfig(
  fs: IFileSystem,
  options: ResolveConfigOptions
): Promise<AppConfig> {
  const { appPaths, env = {} } = options;

  const defaults: AppConfig = {
    substratePath: appPaths.data,
    workingDirectory: appPaths.data,
    sourceCodePath: options.cwd ?? appPaths.data,
    backupPath: path.join(path.dirname(appPaths.data), "substrate-backups"),
    port: 3000,
    model: "sonnet",
    strategicModel: "opus",
    tacticalModel: "sonnet",
    mode: "cycle",
    autoStartOnFirstRun: false,
    autoStartAfterRestart: true,
    backupRetentionCount: 14,
    superegoAuditInterval: 20,
    autonomyReminderInterval: 10,
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
    const cwdConfig = options.cwd ? path.join(options.cwd, "config.json") : undefined;
    if (cwdConfig && await fs.exists(cwdConfig)) {
      const raw = await fs.readFile(cwdConfig);
      fileConfig = JSON.parse(raw) as Partial<AppConfig>;
    } else {
      // Try config-dir config.json
      const configDirFile = path.join(appPaths.config, "config.json");
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
    autonomyReminderInterval: fileConfig.autonomyReminderInterval ?? defaults.autonomyReminderInterval,
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
  };

  // Env vars override everything
  if (env["SUBSTRATE_PATH"]) {
    merged.substratePath = env["SUBSTRATE_PATH"];
  }
  if (env["PORT"]) {
    merged.port = parseInt(env["PORT"], 10);
  }
  if (env["SUPEREGO_AUDIT_INTERVAL"]) {
    merged.superegoAuditInterval = parseInt(env["SUPEREGO_AUDIT_INTERVAL"], 10);
  }
  if (env["AUTONOMY_REMINDER_INTERVAL"]) {
    merged.autonomyReminderInterval = parseInt(env["AUTONOMY_REMINDER_INTERVAL"], 10);
  }

  return merged;
}
