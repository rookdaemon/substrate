import * as path from "node:path";
import * as nodeFs from "node:fs";
import { IFileSystem } from "./substrate/abstractions/IFileSystem";
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { SubstrateConfig } from "./substrate/config";
import { SubstrateInitializer } from "./substrate/initialization/SubstrateInitializer";
import { SubstrateValidator } from "./substrate/initialization/SubstrateValidator";
import { createApplication } from "./loop/createApplication";
import type { AppConfig } from "./config";

export interface StartedServer {
  port: number;
  stop(): Promise<void>;
}

export async function initializeSubstrate(
  fs: IFileSystem,
  substratePath: string
): Promise<void> {
  const config = new SubstrateConfig(substratePath);

  // Initialize substrate files from templates
  const initializer = new SubstrateInitializer(fs, config);
  const initReport = await initializer.initialize();

  if (initReport.created.length > 0) {
    console.log(`Substrate: created ${initReport.created.length} file(s): ${initReport.created.join(", ")}`);
  }

  // Validate substrate
  const validator = new SubstrateValidator(fs, config);
  const validation = await validator.validate();

  if (!validation.valid) {
    const messages: string[] = [];
    for (const missing of validation.missingFiles) {
      messages.push(`Missing: ${missing}`);
    }
    for (const invalid of validation.invalidFiles) {
      messages.push(`Invalid ${invalid.fileType}: ${invalid.errors.join(", ")}`);
    }
    throw new Error(`Substrate validation failed:\n${messages.join("\n")}`);
  }

  console.log("Substrate: validated successfully");
}

export interface StartServerOptions {
  /** Set when supervisor passes --forceStart; server just honors the flag (always auto-start when present). */
  forceStart?: boolean;
}

export async function startServer(config: AppConfig, options?: StartServerOptions): Promise<StartedServer> {
  const fs = new NodeFileSystem();

  // PID file — prevent multiple concurrent instances from corrupting shared substrate files
  const pidPath = path.resolve(config.substratePath, "..", "substrate.pid");
  try {
    const existingPidStr = await fs.readFile(pidPath);
    const existingPid = parseInt(existingPidStr.trim(), 10);
    if (!isNaN(existingPid) && existingPid !== process.pid) {
      try {
        process.kill(existingPid, 0); // throws if process is gone (ESRCH on Unix)
        console.error(`Another server instance is already running (PID ${existingPid}). Stop it before starting a new instance.`);
        process.exit(1);
      } catch {
        // Process not found — stale PID file, safe to proceed
        console.log(`Stale PID file found (PID ${existingPid} not running). Proceeding.`);
      }
    }
  } catch {
    // PID file doesn't exist yet — that's fine
  }
  await fs.writeFile(pidPath, String(process.pid));
  process.on("exit", () => {
    try { nodeFs.unlinkSync(pidPath); } catch { /* ignore */ }
  });

  // Capture app reference so handlers registered below can call app.stop()
  let appForCleanup: Awaited<ReturnType<typeof createApplication>> | null = null;

  const gracefulShutdown = (label: string, err: unknown): void => {
    console.error(`[startup] ${label} — triggering graceful shutdown`, err);
    const graceMs = config.shutdownGraceMs ?? 5000;
    const stop = appForCleanup?.stop() ?? Promise.resolve();
    const timeout = new Promise<void>((resolve) => setTimeout(resolve, graceMs));
    Promise.race([stop, timeout]).finally(() => process.exit(1));
  };

  process.on("unhandledRejection", (reason) => {
    gracefulShutdown("Unhandled promise rejection", reason);
  });

  process.on("uncaughtException", (err) => {
    gracefulShutdown("Uncaught exception", err);
  });

  await initializeSubstrate(fs, config.substratePath);

  const app = await createApplication({
    substratePath: config.substratePath,
    workingDirectory: config.workingDirectory,
    sourceCodePath: config.sourceCodePath,
    model: config.model,
    httpPort: config.port,
    mode: config.mode,
    backupRetentionCount: config.backupRetentionCount,
    superegoAuditInterval: config.superegoAuditInterval,
    cycleDelayMs: config.cycleDelayMs,
    idleSleepConfig: config.idleSleepConfig,
    shutdownGraceMs: config.shutdownGraceMs,
    logLevel: config.logLevel,
    apiToken: config.apiToken,
    watchdog: config.watchdog,
  });
  appForCleanup = app;

  console.log(`Debug log: ${app.logPath}`);

  const boundPort = await app.start(config.port, options?.forceStart);
  console.log(`Server listening on port ${boundPort}`);

  return {
    port: boundPort,
    async stop() {
      await app.stop();
    },
  };
}
