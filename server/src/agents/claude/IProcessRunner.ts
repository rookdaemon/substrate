export interface ProcessResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export interface ProcessRunOptions {
  timeoutMs?: number;
  onStdout?: (chunk: string) => void;
  cwd?: string;
}

export interface IProcessRunner {
  run(
    command: string,
    args: string[],
    options?: ProcessRunOptions
  ): Promise<ProcessResult>;
}
