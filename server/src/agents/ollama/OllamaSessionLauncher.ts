import type { IClock } from "../../substrate/abstractions/IClock";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "../claude/ISessionLauncher";
import type { IHttpClient } from "./IHttpClient";

export const DEFAULT_MODEL = "qwen3:14b";
export const DEFAULT_BASE_URL = "http://localhost:11434";
const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes

/**
 * Ollama message format for the /api/chat endpoint.
 */
export interface OllamaMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Expected response shape from Ollama's POST /api/chat endpoint
 * with stream: false.
 */
interface OllamaResponse {
  model: string;
  message: OllamaMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
  error?: string;
}

/**
 * ISessionLauncher implementation that calls the Ollama REST API
 * for agent reasoning sessions (Ego / Subconscious / Superego / Id).
 *
 * Ollama REST API mapping:
 *   systemPrompt  → messages[0] with role "system"
 *   message       → messages[N] with role "user"
 *   continueSession → messages array grows with conversation history
 *   model         → options.model ?? this.model
 *
 * NOTE: This launcher does NOT support MCP tool execution. The model
 * receives full substrate context via the injected system prompt and
 * must produce its JSON response from that context alone.
 * Tool-based capabilities (file I/O, bash) are not available to the
 * model in this v1 implementation.
 *
 * JSON RELIABILITY: Pass a `outputSchema` in LaunchOptions to use Ollama's
 * built-in grammar-constrained decoding (format field). This prevents the
 * model from producing markdown wrappers, prose preamble, or schema-violating
 * output. Without a schema, `format: "json"` is still applied as a fallback
 * to guarantee at minimum valid JSON.
 *
 * Recommended models for 16GB VRAM (RTX 4090 laptop):
 *   - qwen3:14b     (recommended — ~10-12GB Q4_K_M, 128K ctx, 62 tok/s)
 *   - phi4:14b      (strong reasoning — ~8-10GB Q4)
 *   - mistral-small3.1 (good function calling — ~8-10GB Q4)
 *   - gemma3:12b    (lighter option — ~7-8GB Q4)
 *
 * The baseUrl should point to the Ollama server, which may be remote
 * (e.g. http://nova-host:11434).
 *
 * @author Nova Daemon (original implementation)
 * @author Rook Daemon (port to shared codebase)
 */
export class OllamaSessionLauncher implements ISessionLauncher {
  private readonly model: string;
  private readonly baseUrl: string;
  private conversationHistory: OllamaMessage[] = [];

  constructor(
    private readonly httpClient: IHttpClient,
    private readonly clock: IClock,
    model?: string,
    baseUrl?: string
  ) {
    this.model = model ?? DEFAULT_MODEL;
    this.baseUrl = (baseUrl ?? DEFAULT_BASE_URL).replace(/\/$/, "");
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    const modelToUse = options?.model ?? this.model;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    // Build the message list for this request.
    // If continueSession, append to existing history; otherwise start fresh.
    let messages: OllamaMessage[];

    if (options?.continueSession && this.conversationHistory.length > 0) {
      // Append new user turn to existing conversation
      messages = [
        ...this.conversationHistory,
        { role: "user", content: request.message },
      ];
    } else {
      // Fresh session — optionally reset history
      messages = [];
      if (request.systemPrompt) {
        messages.push({ role: "system", content: request.systemPrompt });
      }
      messages.push({ role: "user", content: request.message });
    }

    // Determine the `format` field for grammar-constrained decoding.
    // If the caller provides an outputSchema, use it directly.
    // Otherwise fall back to "json" to guarantee valid JSON at minimum.
    const format: unknown = options?.outputSchema ?? "json";

    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: modelToUse,
          messages,
          stream: false,
          format,
        },
        { timeoutMs }
      );

      const durationMs = this.clock.now().getTime() - startMs;

      if (!response.ok) {
        const body = await response.text();
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `Ollama returned HTTP ${response.status}: ${body}`,
        };
      }

      const data = (await response.json()) as OllamaResponse;

      if (data.error) {
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `Ollama error: ${data.error}`,
        };
      }

      const assistantContent = data.message?.content ?? "";

      // Update conversation history for future continueSession calls
      if (options?.continueSession) {
        this.conversationHistory = [
          ...messages,
          { role: "assistant", content: assistantContent },
        ];
      } else {
        // Discard history when not in session mode
        this.conversationHistory = [];
      }

      return {
        rawOutput: assistantContent,
        exitCode: 0,
        durationMs,
        success: true,
      };
    } catch (err) {
      const durationMs = this.clock.now().getTime() - startMs;
      const message = err instanceof Error ? err.message : String(err);

      // Provide a useful hint when Ollama is not running
      const isConnectionError =
        message.includes("ECONNREFUSED") ||
        message.includes("fetch failed") ||
        message.includes("connect ECONNREFUSED");

      return {
        rawOutput: "",
        exitCode: 1,
        durationMs,
        success: false,
        error: isConnectionError
          ? `Cannot reach Ollama at ${this.baseUrl} — is the server running? (${message})`
          : message,
      };
    }
  }

  /**
   * Reset conversation history. Useful when starting a fresh task
   * after a session boundary.
   */
  resetHistory(): void {
    this.conversationHistory = [];
  }

  /**
   * Returns the current conversation history length (number of messages).
   * Useful for diagnostics.
   */
  get historyLength(): number {
    return this.conversationHistory.length;
  }
}
