/**
 * Supervisor process — manages the server lifecycle with rebuild-on-restart.
 *
 * Spawns `node dist/cli.js start` as a child process.
 * If the child exits with code 75, runs `tsc` to rebuild, then respawns.
 * Any other exit code propagates to the supervisor's own exit.
 *
 * Usage: node dist/supervisor.js
 */

import { spawn } from "child_process";
import * as path from "path";

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

  for (;;) {
    const exitCode = await run("node", [path.join(serverDir, "dist", "cli.js"), "start"], serverDir);

    if (exitCode !== RESTART_EXIT_CODE) {
      process.exit(exitCode);
    }

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
