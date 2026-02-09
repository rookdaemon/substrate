import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";
import { getAppPaths } from "./paths";
import { resolveConfig } from "./config";
import { initWorkspace } from "./init";
import { startServer } from "./startup";

export interface ParsedArgs {
  command: "init" | "start";
  configPath?: string;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  let command: "init" | "start" = "start";
  let configPath: string | undefined;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "init" || arg === "start") {
      command = arg;
    } else if (arg === "--config" && i + 1 < args.length) {
      configPath = args[++i];
    }
  }

  return { command, configPath };
}

async function main(): Promise<void> {
  const { command, configPath } = parseArgs(process.argv);
  const fs = new NodeFileSystem();
  const appPaths = getAppPaths();

  const config = await resolveConfig(fs, {
    appPaths,
    configPath,
    cwd: process.cwd(),
    env: process.env,
  });

  if (command === "init") {
    await initWorkspace(fs, config, appPaths);
    console.log("Workspace initialized successfully.");
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
