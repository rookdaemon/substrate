export interface ProcessResult {
  success: boolean;
  stdout: string;
  stderr: string;
  exitCode?: number;
}

export interface ProcessOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeout?: number;
}

/**
 * Interface for running subprocess commands
 */
export interface IProcessRunner {
  run(command: string, args: string[], options?: ProcessOptions): Promise<ProcessResult>;
}
