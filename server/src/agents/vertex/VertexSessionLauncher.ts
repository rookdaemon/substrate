import type { IClock } from "../../substrate/abstractions/IClock";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "../claude/ISessionLauncher";
import type { IHttpClient } from "../ollama/IHttpClient";

export const DEFAULT_VERTEX_MODEL = "gemini-2.5-flash";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes
const GOOGLE_AI_BASE_URL = "https://generativelanguage.googleapis.com/v1beta";

/** Returns true if the model name is a Google AI model (gemini-* or gemma-*). */
const isGoogleModel = (model: string): boolean =>
  model.startsWith("gemini-") || model.startsWith("gemma-");

/**
 * Google AI Generative Language API response shape.
 */
interface GoogleAIResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    code?: number;
    message?: string;
    status?: string;
  };
}

/**
 * ISessionLauncher implementation that calls the Google AI Generative Language API
 * for subprocess tasks (compaction, summarization).
 *
 * Uses a simple API key for auth — NOT the Vertex AI SDK or service accounts.
 * API endpoint: generativelanguage.googleapis.com/v1beta/models/{model}:generateContent
 *
 * SUBPROCESS ONLY — this launcher is NOT for cognitive roles.
 * Config validation rejects `sessionLauncher: "vertex"` with an explicit error.
 *
 * Fallback chain position: Ollama (free, local) -> Vertex (GCP credits) -> Claude (paid API)
 *
 * Security:
 * - API key never appears in logs or error messages
 * - Key path logged as [REDACTED]
 * - Key must be delivered via direct file creation, never via Agora or substrate
 *
 * @see https://ai.google.dev/api/generate-content
 */
export class VertexSessionLauncher implements ISessionLauncher {
  private readonly model: string;

  constructor(
    private readonly httpClient: IHttpClient,
    private readonly clock: IClock,
    private readonly apiKey: string,
    model?: string,
  ) {
    this.model = model ?? DEFAULT_VERTEX_MODEL;
  }

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    const startMs = this.clock.now().getTime();
    // Only accept Gemini/Gemma model names — reject Claude or other non-Google models
    // that TaskClassifier may supply, to avoid silent 404 failures from Google AI API.
    const modelToUse = options?.model && isGoogleModel(options.model) ? options.model : this.model;
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const url = `${GOOGLE_AI_BASE_URL}/models/${modelToUse}:generateContent?key=${this.apiKey}`;

    // Build request payload for Google AI Generative Language API
    const contents: Array<{ role: string; parts: Array<{ text: string }> }> = [];

    contents.push({
      role: "user",
      parts: [{ text: request.message }],
    });

    const body: Record<string, unknown> = { contents };

    // System instruction is a top-level field in Google AI (not in contents array)
    if (request.systemPrompt) {
      body.systemInstruction = {
        parts: [{ text: request.systemPrompt }],
      };
    }

    try {
      const response = await this.httpClient.post(url, body, { timeoutMs });
      const durationMs = this.clock.now().getTime() - startMs;

      if (!response.ok) {
        const errorText = await response.text();
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `Google AI returned HTTP ${response.status}: ${this.redactKey(errorText)}`,
        };
      }

      const data = (await response.json()) as GoogleAIResponse;

      if (data.error) {
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `Google AI error: ${this.redactKey(data.error.message ?? JSON.stringify(data.error))}`,
        };
      }

      const text = data.candidates?.[0]?.content?.parts?.[0]?.text ?? "";

      return {
        rawOutput: text,
        exitCode: 0,
        durationMs,
        success: true,
      };
    } catch (err) {
      const durationMs = this.clock.now().getTime() - startMs;
      const message = err instanceof Error ? err.message : String(err);
      return {
        rawOutput: "",
        exitCode: 1,
        durationMs,
        success: false,
        error: `Google AI request failed: ${this.redactKey(message)}`,
      };
    }
  }

  /**
   * Health probe: list models to verify API key is valid and API is reachable.
   * Returns true if the API responds with HTTP 200.
   */
  async healthy(): Promise<boolean> {
    try {
      const url = `${GOOGLE_AI_BASE_URL}/models?key=${this.apiKey}&pageSize=1`;
      const response = await this.httpClient.get(url, { timeoutMs: 10000 });
      return response.ok;
    } catch {
      return false;
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
