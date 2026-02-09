import { spawn } from "child_process";
import {
  IProcessRunner,
  ProcessResult,
  ProcessRunOptions,
} from "./IProcessRunner";

const DEFAULT_TIMEOUT_MS = 120_000;

export class NodeProcessRunner implements IProcessRunner {
  async run(
    command: string,
    args: string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    return new Promise<ProcessResult>((resolve, reject) => {
      const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });

      let stdout = "";
      let stderr = "";

      child.stdout.on("data", (data: Buffer) => {
        const chunk = data.toString();
        stdout += chunk;
        options?.onStdout?.(chunk);
      });

      child.stderr.on("data", (data: Buffer) => {
        stderr += data.toString();
      });

      const timer = setTimeout(() => {
        child.kill("SIGTERM");
        reject(new Error(`Process timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.on("close", (code) => {
        clearTimeout(timer);
        resolve({ stdout, stderr, exitCode: code ?? 1 });
      });

      child.on("error", (err) => {
        clearTimeout(timer);
        reject(err);
      });
    });
  }
}
