export interface ProcessLogEntry {
  type: "thinking" | "text" | "tool_use" | "tool_result" | "status";
  content: string;
}

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
  model?: string;
  maxRetries?: number;
  retryDelayMs?: number;
  timeoutMs?: number;
  idleTimeoutMs?: number;
  onLogEntry?: (entry: ProcessLogEntry) => void;
  cwd?: string;
  continueSession?: boolean;
  persistSession?: boolean;
  /**
   * JSON Schema for grammar-constrained decoding.
   * Used by OllamaSessionLauncher to enforce structured output via Ollama's
   * `format` field. Claude-based launchers may ignore this field since they
   * rely on extractJson() post-processing.
   *
   * When provided, the model is constrained to produce output matching this
   * schema exactly — no markdown wrappers, no prose preamble, no extra fields.
   */
  outputSchema?: Record<string, unknown>;
}

export interface ISessionLauncher {
  launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions
  ): Promise<ClaudeSessionResult>;
}
