import * as path from "node:path";
import { NodeEnvironment } from "./substrate/abstractions/NodeEnvironment";
import { NodeProcessRunner } from "./agents/claude/NodeProcessRunner";
import { getAppPaths } from "./paths";
import { resolveConfig } from "./config";
import { initWorkspace } from "./init";
import { startServer } from "./startup";
import { createBackup, createRemoteBackup, restoreBackup } from "./backup";
import { resolveRemotePath as resolveBackupSource } from "./transfer";
import { transfer, resolveRemotePath, resolveRemoteConfigPath } from "./transfer";
import { fetchRemoteLogs, fetchLocalLogs } from "./logs";

export interface ParsedArgs {
  command: "init" | "start" | "backup" | "restore" | "transfer" | "logs";
  configPath?: string;
  model?: string;
  outputDir?: string;
  inputPath?: string;
  source?: string;
  dest?: string;
  identity?: string;
  lines?: number;
  /** Set when supervisor passes --forceStart (respawn after exit 75); server uses it with config to decide auto-start. */
  forceStart?: boolean;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command: "init" | "start" | "backup" | "restore" | "transfer" | "logs" = "start";
  let configPath: string | undefined;
  let model: string | undefined;
  let outputDir: string | undefined;
  let inputPath: string | undefined;
  let source: string | undefined;
  let dest: string | undefined;
  let identity: string | undefined;
  let lines: number | undefined;
  let forceStart = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "init" || arg === "start" || arg === "backup" || arg === "restore" || arg === "transfer" || arg === "logs") {
      command = arg;
    } else if (arg === "--forceStart") {
      forceStart = true;
    } else if (arg === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg === "--model" && i + 1 < args.length) {
      model = args[++i];
    } else if (arg === "--output" && i + 1 < args.length) {
      outputDir = args[++i];
    } else if (arg === "--input" && i + 1 < args.length) {
      inputPath = args[++i];
    } else if (arg === "--source" && i + 1 < args.length) {
      source = args[++i];
    } else if (arg === "--dest" && i + 1 < args.length) {
      dest = args[++i];
    } else if ((arg === "-i" || arg === "--identity") && i + 1 < args.length) {
      identity = args[++i];
    } else if ((arg === "-n" || arg === "--lines") && i + 1 < args.length) {
      lines = parseInt(args[++i], 10);
    }
  }

  return { command, configPath, model, outputDir, inputPath, source, dest, identity, lines, forceStart };
}

async function main(): Promise<void> {
  const { command, configPath, model, outputDir, inputPath, source, dest, identity, lines, forceStart } = parseArgs(process.argv);
  const env = new NodeEnvironment();
  const appPaths = getAppPaths({ env });

  const config = await resolveConfig(env, {
    appPaths,
    configPath,
    cwd: process.cwd(),
  });

  // CLI --model overrides config file
  if (model) {
    config.model = model;
  }

  if (command === "init") {
    await initWorkspace(env.fs, config, appPaths);
    console.log("Workspace initialized successfully.");
  } else if (command === "backup") {
    const isRemote = source && source.includes("@");
    const backupOutputDir = outputDir ?? config.backupPath;
    const result = isRemote
      ? await createRemoteBackup({
          fs: env.fs,
          runner: new NodeProcessRunner(),
          clock: env.clock,
          remoteSource: resolveBackupSource(source),
          outputDir: backupOutputDir,
          identity,
        })
      : await createBackup({
          fs: env.fs,
          runner: new NodeProcessRunner(),
          clock: env.clock,
          substratePath: source ?? config.substratePath,
          outputDir: backupOutputDir,
        });
    if (result.success) {
      console.log(`Backup created: ${result.outputPath}`);
    } else {
      console.error(`Backup failed: ${result.error}`);
      process.exit(1);
    }
  } else if (command === "restore") {
    const result = await restoreBackup({
      fs: env.fs,
      runner: new NodeProcessRunner(),
      substratePath: config.substratePath,
      inputPath,
      backupDir: config.backupPath,
    });
    if (result.success) {
      console.log(`Restored from: ${result.restoredFrom}`);
    } else {
      console.error(`Restore failed: ${result.error}`);
      process.exit(1);
    }
  } else if (command === "transfer") {
    if (!dest) {
      console.error("Usage: transfer --dest <user@host | path> [--source <path>] [-i <identity>]");
      process.exit(1);
    }
    const resolvedSource = source ?? config.substratePath;
    const resolvedDest = resolveRemotePath(dest);
    const destConfig = resolveRemoteConfigPath(dest);
    const result = await transfer({
      runner: new NodeProcessRunner(),
      sourceSubstrate: resolvedSource,
      destSubstrate: resolvedDest,
      sourceConfig: destConfig ? appPaths.config : undefined,
      destConfig: destConfig ?? undefined,
      identity,
    });
    if (result.success) {
      console.log(`Transfer complete: ${resolvedSource} → ${resolvedDest}`);
      if (destConfig) {
        console.log(`Config synced: ${appPaths.config} → ${destConfig}`);
      }
    } else {
      console.error(`Transfer failed: ${result.error}`);
      process.exit(1);
    }
  } else if (command === "logs") {
    if (source && source.includes("@")) {
      const result = await fetchRemoteLogs({
        runner: new NodeProcessRunner(),
        host: source,
        identity,
        lines,
      });
      if (result.success) {
        process.stdout.write(result.output!);
      } else {
        console.error(`Failed to fetch logs: ${result.error}`);
        process.exit(1);
      }
    } else {
      const logPath = source ?? path.resolve(config.substratePath, "..", "debug.log");
      const result = await fetchLocalLogs({ fs: env.fs, logPath });
      if (result.success) {
        process.stdout.write(result.output!);
      } else {
        console.error(`Failed to read logs: ${result.error}`);
        process.exit(1);
      }
    }
  } else {
    await startServer(config, { forceStart });
  }
}

// Skip main() in test runners (Jest sets JEST_WORKER_ID)
if (!process.env.JEST_WORKER_ID) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
