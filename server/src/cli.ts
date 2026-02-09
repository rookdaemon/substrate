import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { SystemClock } from "./substrate/abstractions/SystemClock";
import { NodeProcessRunner } from "./agents/claude/NodeProcessRunner";
import { getAppPaths } from "./paths";
import { resolveConfig } from "./config";
import { initWorkspace } from "./init";
import { startServer } from "./startup";
import { createBackup } from "./backup";

export interface ParsedArgs {
  command: "init" | "start" | "backup";
  configPath?: string;
  model?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command: "init" | "start" | "backup" = "start";
  let configPath: string | undefined;
  let model: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "init" || arg === "start" || arg === "backup") {
      command = arg;
    } else if (arg === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    } else if (arg === "--model" && i + 1 < args.length) {
      model = args[++i];
    }
  }

  return { command, configPath, model };
}

async function main(): Promise<void> {
  const { command, configPath, model } = parseArgs(process.argv);
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
      configDir: appPaths.config,
      dataDir: appPaths.data,
      outputDir: process.cwd(),
    });
    if (result.success) {
      console.log(`Backup created: ${result.outputPath}`);
    } else {
      console.error(`Backup failed: ${result.error}`);
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
