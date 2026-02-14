/**
 * Supervisor process — manages the server lifecycle with rebuild-on-restart.
 *
 * Spawns `node dist/cli.js start` (optionally with --forceStart). The server only honors the flag:
 * when --forceStart is present it always auto-starts the loop; it does not read config for that.
 * This loop uses isFirstTime and config to decide whether to add --forceStart:
 * - First run: add --forceStart iff autoStartOnFirstRun is true (default false).
 * - After restart (exit 75): add --forceStart iff autoStartAfterRestart is true (default true).
 * - Any other exit code: propagate (clean exit; no restart).
 *
 * Usage: node dist/supervisor.js
 */

import { spawn } from "child_process";
import * as path from "path";
import { resolveConfig } from "./config";
import { getAppPaths } from "./paths";
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";

const RESTART_EXIT_CODE = 75;
const BUILD_RETRY_DELAY_MS = 10_000;

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function main(): Promise<void> {
  const serverDir = path.resolve(__dirname, "..");
  const cliPath = path.join(serverDir, "dist", "cli.js");
  const fs = new NodeFileSystem();
  const resolveOptions = {
    appPaths: getAppPaths(),
    cwd: process.cwd(),
    env: process.env,
  };
  let isFirstTime = true;

  for (;;) {
    const config = await resolveConfig(fs, resolveOptions);
    const useForceStart = isFirstTime
      ? config.autoStartOnFirstRun === true
      : config.autoStartAfterRestart !== false;
    const startArgs = [cliPath, "start"];
    if (useForceStart) startArgs.push("--forceStart");

    const exitCode = await run("node", startArgs, serverDir);

    if (exitCode !== RESTART_EXIT_CODE) {
      process.exit(exitCode);
    }

    isFirstTime = false;
    console.log("[supervisor] Restart requested (exit code 75) — rebuilding...");

    const buildCode = await run("npx", ["tsc"], serverDir);
    if (buildCode !== 0) {
      console.error(`[supervisor] Build failed (exit code ${buildCode}), retrying in ${BUILD_RETRY_DELAY_MS / 1000}s...`);
      await new Promise((r) => setTimeout(r, BUILD_RETRY_DELAY_MS));
    } else {
      console.log("[supervisor] Build succeeded — restarting server");
    }
  }
}

main().catch((err) => {
  console.error("[supervisor] Fatal error:", err);
  process.exit(1);
});
