import type { IClock } from "../../substrate/abstractions/IClock";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "../claude/ISessionLauncher";
import type { IHttpClient } from "../ollama/IHttpClient";

export const DEFAULT_GROQ_MODEL = "llama3-70b-8192";
const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

/**
 * OpenAI-compatible chat message format used by Groq's API.
 */
interface GroqMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

/**
 * Expected response shape from Groq's POST /chat/completions endpoint.
 */
interface GroqResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
    type?: string;
    code?: string;
  };
}

/**
 * ISessionLauncher implementation that calls Groq's OpenAI-compatible API
 * for agent reasoning sessions (Id subprocess role and similar).
 *
 * Groq provides LLaMA-3 70B at ~800 tok/s on the free tier (100k tokens/day,
 * 30 req/min per API key) — adequate for sparse subprocess usage.
 *
 * API endpoint: https://api.groq.com/openai/v1/chat/completions
 * Auth: Authorization: Bearer <GROQ_API_KEY>
 *
 * Graceful fallback: if GROQ_API_KEY is absent or empty, launch() throws
 * immediately so the OllamaOffload try-skip pattern can handle it.
 *
 * Config shape (config.json):
 *   { "sessionLauncher": "groq", "groqModel": "llama3-70b-8192" }
 *   { "idLauncher": "groq", "groqModel": "llama3-70b-8192" }
 *
 * @see https://console.groq.com/docs/openai
 */
export class GroqSessionLauncher implements ISessionLauncher {
  private readonly model: string;
  private readonly apiKey: string;

  constructor(
    private readonly httpClient: IHttpClient,
    private readonly clock: IClock,
    apiKey: string,
    model?: string,
  ) {
    if (!apiKey) {
      throw new Error(
        "GroqSessionLauncher: GROQ_API_KEY is missing or empty. " +
          "Set the GROQ_API_KEY environment variable to enable Groq inference.",
      );
    }
    this.apiKey = apiKey;
    this.model = model ?? DEFAULT_GROQ_MODEL;
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    const modelToUse = options?.model ?? this.model;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const messages: GroqMessage[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.message });

    try {
      const response = await this.httpClient.post(
        `${GROQ_BASE_URL}/chat/completions`,
        { model: modelToUse, messages },
        {
          timeoutMs,
          headers: { Authorization: `Bearer ${this.apiKey}` },
        },
      );

      const durationMs = this.clock.now().getTime() - startMs;

      if (!response.ok) {
        const errorText = await response.text();
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `Groq returned HTTP ${response.status}: ${this.redactKey(errorText)}`,
        };
      }

      const data = (await response.json()) as GroqResponse;

      if (data.error) {
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `Groq API error: ${this.redactKey(data.error.message ?? JSON.stringify(data.error))}`,
        };
      }

      const text = data.choices?.[0]?.message?.content ?? "";

      return {
        rawOutput: text,
        exitCode: 0,
        durationMs,
        success: true,
      };
    } catch (err) {
      const durationMs = this.clock.now().getTime() - startMs;
      const message = err instanceof Error ? err.message : String(err);

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
          ? `Cannot reach Groq API at ${GROQ_BASE_URL} — check network connectivity. (${this.redactKey(message)})`
          : this.redactKey(message),
      };
    }
  }

  /**
   * Strip the API key from any string to prevent accidental logging.
   */
  private redactKey(text: string): string {
    if (!this.apiKey) return text;
    return text.replaceAll(this.apiKey, "[REDACTED]");
  }
}
