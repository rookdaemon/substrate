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
 * Rollback behavior:
 * - After a successful build and restart, polls /api/health/critical (5 attempts, 2s intervals).
 * - On healthy restart: tags current commit as `last-known-good`.
 * - After 3 consecutive unhealthy restarts: checks out `last-known-good`, rebuilds, and restarts.
 *
 * Usage: node dist/supervisor.js
 */

import { spawn } from "child_process";
import * as path from "path";
import { resolveConfig } from "./config";
import { getAppPaths } from "./paths";
import { NodeFileSystem } from "./substrate/abstractions/NodeFileSystem";

const RESTART_EXIT_CODE = 75;
const MAX_BUILD_RETRIES = 5;
const INITIAL_RETRY_DELAY_MS = 5_000;
const MAX_RETRY_DELAY_MS = 60_000;
const BACKOFF_MULTIPLIER = 2;
const HEALTH_CHECK_ATTEMPTS = 5;
const HEALTH_CHECK_INTERVAL_MS = 2_000;
const MAX_CONSECUTIVE_UNHEALTHY = 3;

function run(cmd: string, args: string[], cwd: string): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(cmd, args, { stdio: "inherit", cwd });
    child.on("exit", (code) => resolve(code ?? 1));
    child.on("error", () => resolve(1));
  });
}

async function waitForHealthy(port: number, maxAttempts = HEALTH_CHECK_ATTEMPTS): Promise<boolean> {
  const url = `http://127.0.0.1:${port}/api/health/critical`;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }
    try {
      const res = await fetch(url);
      if (res.ok) return true;
    } catch {
      // Server not yet up — continue polling
    }
  }
  return false;
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
  let consecutiveUnhealthyRestarts = 0;

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
      console.log("[supervisor] Build succeeded — restarting server");

      const healthy = await waitForHealthy(config.port);
      if (healthy) {
        consecutiveUnhealthyRestarts = 0;
        // Tag current commit as last-known-good
        await run("git", ["tag", "-f", "last-known-good"], serverDir);
        console.log("[supervisor] Server is healthy — tagged current commit as last-known-good");
      } else {
        consecutiveUnhealthyRestarts++;
        console.error(`[supervisor] Health check failed after restart (${consecutiveUnhealthyRestarts}/${MAX_CONSECUTIVE_UNHEALTHY})`);

        if (consecutiveUnhealthyRestarts >= MAX_CONSECUTIVE_UNHEALTHY) {
          console.error("[supervisor] 3 consecutive unhealthy restarts — rolling back to last-known-good");
          const checkoutCode = await run("git", ["checkout", "last-known-good"], serverDir);
          if (checkoutCode !== 0) {
            console.error("[supervisor] Rollback failed — no last-known-good tag found, giving up");
            process.exit(1);
          }
          const rollbackBuildCode = await run("npx", ["tsc"], serverDir);
          if (rollbackBuildCode !== 0) {
            console.error("[supervisor] Rollback build failed, giving up");
            process.exit(1);
          }
          consecutiveUnhealthyRestarts = 0;
          console.log("[supervisor] Rollback build succeeded — restarting with last-known-good version");
        }
      }
    }
  }
}

main().catch((err) => {
  console.error("[supervisor] Fatal error:", err);
  process.exit(1);
});
