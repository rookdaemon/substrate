import { ProcessLogEntry } from "./StreamJsonParser";

export interface ClaudeSessionRequest {
  systemPrompt: string;
  message: string;
}

export interface ClaudeSessionResult {
  rawOutput: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
  error?: string;
}

export interface LaunchOptions {
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onLogEntry?: (entry: ProcessLogEntry) => void;
  cwd?: string;
}

export interface ISessionLauncher {
  launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions
  ): Promise<ClaudeSessionResult>;
}

export type { ProcessLogEntry };
