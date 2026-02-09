import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { SystemClock } from "./substrate/abstractions/SystemClock";
import { NodeProcessRunner } from "./agents/claude/NodeProcessRunner";
import { getAppPaths } from "./paths";
import { resolveConfig } from "./config";
import { initWorkspace } from "./init";
import { startServer } from "./startup";
import { createBackup, restoreBackup } from "./backup";
import { transfer, resolveRemotePath, resolveRemoteConfigPath } from "./transfer";

export interface ParsedArgs {
  command: "init" | "start" | "backup" | "restore" | "transfer";
  configPath?: string;
  model?: string;
  outputDir?: string;
  inputPath?: string;
  source?: string;
  dest?: string;
  identity?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command: "init" | "start" | "backup" | "restore" | "transfer" = "start";
  let configPath: string | undefined;
  let model: string | undefined;
  let outputDir: string | undefined;
  let inputPath: string | undefined;
  let source: string | undefined;
  let dest: string | undefined;
  let identity: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "init" || arg === "start" || arg === "backup" || arg === "restore" || arg === "transfer") {
      command = arg;
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
    }
  }

  return { command, configPath, model, outputDir, inputPath, source, dest, identity };
}

async function main(): Promise<void> {
  const { command, configPath, model, outputDir, source, dest, identity } = parseArgs(process.argv);
  const fs = new NodeFileSystem();
  const appPaths = getAppPaths();

  const config = await resolveConfig(fs, {
    appPaths,
    configPath,
    cwd: process.cwd(),
    env: process.env,
  });

  // CLI --model overrides config file
  if (model) {
    config.model = model;
  }

  if (command === "init") {
    await initWorkspace(fs, config, appPaths);
    console.log("Workspace initialized successfully.");
  } else if (command === "backup") {
    const result = await createBackup({
      fs,
      runner: new NodeProcessRunner(),
      clock: new SystemClock(),
      substratePath: config.substratePath,
      outputDir: outputDir ?? config.backupPath,
    });
    if (result.success) {
      console.log(`Backup created: ${result.outputPath}`);
    } else {
      console.error(`Backup failed: ${result.error}`);
      process.exit(1);
    }
  } else if (command === "restore") {
    const result = await restoreBackup({
      fs,
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
  } else {
    await startServer(config);
  }
}

// Only run when executed directly (not when imported by tests)
if (require.main === module) {
  main().catch((err) => {
    console.error("Fatal:", err);
    process.exit(1);
  });
}
