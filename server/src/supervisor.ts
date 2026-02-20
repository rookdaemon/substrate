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
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";

const RESTART_EXIT_CODE = 75;
const MAX_BUILD_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

export async function validateRestartSafety(
  serverDir: string,
  dataDir: string,
  fs: IFileSystem
): Promise<boolean> {
  // 1. Run tests
  const testCode = await run("npm", ["test"], serverDir);
  if (testCode !== 0) {
    console.error("[supervisor] Safety gate failed: tests did not pass");
    return false;
  }

  // 2. Check restart-context.md
  const restartContextPath = path.join(dataDir, "memory", "restart-context.md");
  const contextExists = await fs.exists(restartContextPath);
  if (!contextExists) {
    console.error("[supervisor] Safety gate failed: memory/restart-context.md does not exist");
    return false;
  }
  const stat = await fs.stat(restartContextPath);
  if (stat.size === 0) {
    console.error("[supervisor] Safety gate failed: memory/restart-context.md is empty");
    return false;
  }

  // 3. Check git state
  const gitStatusCode = await run("git", ["diff-index", "--quiet", "HEAD", "--"], serverDir);
  if (gitStatusCode !== 0) {
    console.error("[supervisor] Safety gate failed: uncommitted changes in working tree");
    return false;
  }

  return true;
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
  let consecutiveFailures = 0;
  let currentRetryDelay = INITIAL_RETRY_DELAY_MS;

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
      consecutiveFailures++;
      if (consecutiveFailures >= MAX_BUILD_RETRIES) {
        console.error(`[supervisor] Build failed ${consecutiveFailures} times, giving up`);
        process.exit(1);
      }
      // Log with current delay, then wait and update for next iteration
      console.error(`[supervisor] Build failed (attempt ${consecutiveFailures}/${MAX_BUILD_RETRIES}), retrying in ${currentRetryDelay / 1000}s...`);
      await new Promise((r) => setTimeout(r, currentRetryDelay));
      currentRetryDelay = Math.min(currentRetryDelay * BACKOFF_MULTIPLIER, MAX_RETRY_DELAY_MS);
    } else {
      consecutiveFailures = 0;
      currentRetryDelay = INITIAL_RETRY_DELAY_MS;
      const skipGates = process.argv.includes("--skip-safety-gates");
      if (!skipGates) {
        const safeToRestart = await validateRestartSafety(serverDir, config.workingDirectory, fs);
        if (!safeToRestart) {
          console.error("[supervisor] Restart aborted due to failed safety gates");
          process.exit(1);
        }
      }
      console.log("[supervisor] Build succeeded — restarting server");
    }
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error("[supervisor] Fatal error:", err);
    process.exit(1);
  });
}
