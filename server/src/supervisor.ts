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
 * Safety gates (pre-restart):
 * - Runs tests, checks restart-context.md exists/non-empty, and verifies clean git state.
 * - Skip with --skip-safety-gates flag.
 *
 * Rollback behavior (post-restart):
 * - After a successful build and restart, polls /api/health/critical (5 attempts, 2s intervals).
 * - On healthy restart: tags current commit as `last-known-good`.
 * - After 3 consecutive unhealthy restarts: checks out `last-known-good`, rebuilds, and restarts.
 *
 * Usage: node dist/supervisor.js
 */

import { spawn } from "node:child_process";
import * as path from "node:path";
import { NodeEnvironment } from "./substrate/abstractions/NodeEnvironment";
import { resolveConfig } from "./config";
import { getAppPaths } from "./paths";
import type { IFileSystem } from "./substrate/abstractions/IFileSystem";

declare const __dirname: string;
const SERVER_DIR =
  typeof __dirname !== "undefined" ? path.resolve(__dirname, "..") : process.cwd();

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

async function waitForHealthy(port: number, maxAttempts = HEALTH_CHECK_ATTEMPTS): Promise<{ healthy: boolean; body?: unknown }> {
  const url = `http://127.0.0.1:${port}/api/health/critical`;
  let lastBody: unknown;
  for (let i = 0; i < maxAttempts; i++) {
    if (i > 0) {
      await new Promise((r) => setTimeout(r, HEALTH_CHECK_INTERVAL_MS));
    }
    try {
      const res = await fetch(url);
      try { lastBody = await res.json(); } catch { /* not JSON */ }
      if (res.ok) return { healthy: true, body: lastBody };
    } catch {
      // Server not yet up — continue polling
    }
  }
  return { healthy: false, body: lastBody };
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

  // 2. Check restart-context.md (posix for cross-platform tests with in-memory fs)
  const dataDirPosix = dataDir.replace(/\\/g, "/");
  const restartContextPath = path.posix.join(dataDirPosix, "memory", "restart-context.md");
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
  const cliPath = path.join(SERVER_DIR, "dist", "cli.js");
  const env = new NodeEnvironment();
  const resolveOptions = {
    appPaths: getAppPaths({ env }),
    cwd: process.cwd(),
  };
  let isFirstTime = true;
  let consecutiveFailures = 0;
  let currentRetryDelay = INITIAL_RETRY_DELAY_MS;
  let consecutiveUnhealthyRestarts = 0;

  for (;;) {
    const config = await resolveConfig(env, resolveOptions);
    const useForceStart = isFirstTime
      ? config.autoStartOnFirstRun === true
      : config.autoStartAfterRestart !== false;
    const startArgs = [cliPath, "start"];
    if (useForceStart) startArgs.push("--forceStart");

    const exitCode = await run("node", startArgs, SERVER_DIR);

    if (exitCode !== RESTART_EXIT_CODE) {
      process.exit(exitCode);
    }

    isFirstTime = false;
    console.log("[supervisor] Restart requested (exit code 75) — rebuilding...");

    const buildCode = await run("npx", ["tsc"], SERVER_DIR);
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
        const safeToRestart = await validateRestartSafety(SERVER_DIR, config.workingDirectory, env.fs);
        if (!safeToRestart) {
          console.error("[supervisor] Restart aborted due to failed safety gates");
          process.exit(1);
        }
      }
      console.log("[supervisor] Build succeeded — restarting server");

      const { healthy, body: healthBody } = await waitForHealthy(config.port);
      if (healthy) {
        consecutiveUnhealthyRestarts = 0;
        // Tag current commit as last-known-good
        await run("git", ["tag", "-f", "last-known-good"], SERVER_DIR);
        console.log("[supervisor] Server is healthy — tagged current commit as last-known-good");
      } else {
        consecutiveUnhealthyRestarts++;
        console.error(`[supervisor] Health check failed after restart (${consecutiveUnhealthyRestarts}/${MAX_CONSECUTIVE_UNHEALTHY}):`, JSON.stringify(healthBody, null, 2));

        if (consecutiveUnhealthyRestarts >= MAX_CONSECUTIVE_UNHEALTHY) {
          // Save health diagnostics to restart-context.md before rollback
          const restartContextPath = path.posix.join(
            config.workingDirectory.replace(/\\/g, "/"),
            "memory",
            "restart-context.md"
          );
          const healthSection = `\n## Health Check at Rollback Trigger\n\`\`\`json\n${JSON.stringify(healthBody, null, 2)}\n\`\`\`\n`;
          try {
            await env.fs.mkdir(path.posix.join(config.workingDirectory.replace(/\\/g, "/"), "memory"), { recursive: true });
            const existing = await env.fs.exists(restartContextPath) ? await env.fs.readFile(restartContextPath) : "";
            await env.fs.writeFile(restartContextPath, existing + healthSection);
          } catch { /* best effort — don't block rollback */ }

          console.error("[supervisor] 3 consecutive unhealthy restarts — rolling back to last-known-good");
          const checkoutCode = await run("git", ["checkout", "last-known-good"], SERVER_DIR);
          if (checkoutCode !== 0) {
            console.error("[supervisor] Rollback failed — no last-known-good tag found, giving up");
            process.exit(1);
          }
          // IMPORTANT: Use npm run build (tsup), not npx tsc directly.
          // Raw tsc produces different output than tsup and may succeed while generating a broken binary.
          const rollbackBuildCode = await run("npm", ["run", "build"], SERVER_DIR);
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

// Skip main() in test runners (Jest sets JEST_WORKER_ID)
if (!process.env.JEST_WORKER_ID) {
  main().catch((err) => {
    console.error("[supervisor] Fatal error:", err);
    process.exit(1);
  });
}
