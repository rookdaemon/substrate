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
const INITIAL_BUILD_RETRY_DELAY_MS = 10_000;
const MAX_BUILD_RETRIES = 10;
const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

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
  let buildRetryCount = 0;

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
      buildRetryCount++;
      
      if (buildRetryCount >= MAX_BUILD_RETRIES) {
        console.error(`[supervisor] Build failed ${MAX_BUILD_RETRIES} times. Exhausted retries. Exiting.`);
        process.exit(1);
      }
      
      // Exponential backoff: 10s, 20s, 40s, 80s, ... capped at 5 minutes
      const backoffMs = Math.min(
        INITIAL_BUILD_RETRY_DELAY_MS * Math.pow(2, buildRetryCount - 1),
        MAX_BACKOFF_MS
      );
      
      console.error(
        `[supervisor] Build failed (exit code ${buildCode}), retry ${buildRetryCount}/${MAX_BUILD_RETRIES} in ${backoffMs / 1000}s...`
      );
      await new Promise((r) => setTimeout(r, backoffMs));
    } else {
      buildRetryCount = 0; // Reset counter on successful build
      console.log("[supervisor] Build succeeded — restarting server");
    }
  }
}

main().catch((err) => {
  console.error("[supervisor] Fatal error:", err);
  process.exit(1);
});
