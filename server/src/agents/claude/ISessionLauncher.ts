export interface ProcessLogEntry {
  type: "thinking" | "text" | "tool_use" | "tool_result" | "status";
  content: string;
}

export interface ClaudeSessionRequest {
  systemPrompt: string;
  message: string;
}

export interface SessionUsage {
  provider: "claude" | "codex" | "gemini" | "groq" | "anthropic" | "ollama" | "vertex" | "copilot" | "deterministic";
  model?: string;
  promptTokens?: number;
  cachedInputTokens?: number;
  nonCachedInputTokens?: number;
  completionTokens?: number;
  reasoningOutputTokens?: number;
  totalTokens?: number;
  costUsd?: number;
  costKnown: boolean;
  costEstimate: boolean;
  billingSource: "sdk" | "api_usage" | "cli_usage" | "static_estimate" | "free_tier" | "subscription" | "local" | "unknown";
  telemetrySource: string;
}

export interface SessionUsageContext {
  role: string;
  operation: string;
}

export interface ClaudeSessionResult {
  rawOutput: string;
  exitCode: number;
  durationMs: number;
  success: boolean;
  error?: string;
  usage?: SessionUsage;
}

export interface LaunchOptions {
  model?: string;
  /** Frontier/expensive model use must be opted into at the call site under Survival Mode. */
  allowFrontierModel?: boolean;
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
  /**
   * Additional directories to expose to the Claude session beyond `cwd`.
   * AgentSdkLauncher passes these as `additionalDirectories` to the SDK.
   * CopilotSessionLauncher passes each as a separate `--add-dir` argument.
   * Other launchers (Gemini, Ollama, Vertex) ignore this field.
   */
  additionalDirs?: string[];
  usageContext?: SessionUsageContext;
}

export interface ISessionLauncher {
  launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions
  ): Promise<ClaudeSessionResult>;
}
