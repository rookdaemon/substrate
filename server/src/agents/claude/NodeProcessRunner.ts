import { spawn } from "child_process";
import {
  IProcessRunner,
  ProcessResult,
  ProcessRunOptions,
} from "./IProcessRunner";

const DEFAULT_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes hard ceiling
const DEFAULT_IDLE_TIMEOUT_MS = 300_000;    // 5 minutes without output (Claude generates large tool_use blocks with no intermediate output)

export class NodeProcessRunner implements IProcessRunner {
  async run(
    command: string,
    args: string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const idleTimeoutMs = options?.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS;

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], cwd: options?.cwd });

      let stdout = "";
      let stderr = "";

      const clearTimers = () => {
        clearTimeout(hardTimer);
        clearTimeout(idleTimer);
      };

      const resetIdleTimer = () => {
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => {
          child.kill("SIGTERM");
          reject(new Error(`Process idle for ${idleTimeoutMs}ms with no output`));
        }, idleTimeoutMs);
      };

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        options?.onStdout?.(chunk);
        resetIdleTimer();
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
        resetIdleTimer();
      });

      const hardTimer = setTimeout(() => {
        clearTimers();
        child.kill("SIGTERM");
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      let idleTimer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Process idle for ${idleTimeoutMs}ms with no output`));
      }, idleTimeoutMs);

      child.on("close", (code) => {
        clearTimers();
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on("error", (err) => {
        clearTimers();
        reject(err);
      });
    });
  }
}
