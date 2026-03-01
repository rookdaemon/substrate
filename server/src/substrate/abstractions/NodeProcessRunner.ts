import { IProcessRunner, ProcessResult, ProcessOptions } from "./IProcessRunner";
import { spawn } from "node:child_process";

export class NodeProcessRunner implements IProcessRunner {
  async run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult> {
    return new Promise((resolve) => {
      const proc = spawn(command, args, {
        cwd: options?.cwd,
        env: options?.env ? { ...process.env, ...options.env } : process.env,
      });

      let stdout = "";
      let stderr = "";

      if (proc.stdout) {
        proc.stdout.on("data", (data) => {
          stdout += data.toString();
        });
      }

      if (proc.stderr) {
        proc.stderr.on("data", (data) => {
          stderr += data.toString();
        });
      }

      proc.on("close", (exitCode) => {
        resolve({
          success: exitCode === 0,
          stdout,
          stderr,
          exitCode: exitCode ?? undefined,
        });
      });

      proc.on("error", (error) => {
        resolve({
          success: false,
          stdout,
          stderr: stderr + "\n" + error.message,
          exitCode: 1,
        });
      });
    });
  }
}
