export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunOptions {
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onStdout?: (chunk: string) => void;
  cwd?: string;
  stdin?: string;
  env?: Record<string, string | undefined>;
}

export interface IProcessRunner {
  run(
    command: string,
    args: string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult>;
}
