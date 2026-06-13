import type { IClock } from "../../substrate/abstractions/IClock";
import type {
  ISessionLauncher,
  ClaudeSessionRequest,
  ClaudeSessionResult,
  LaunchOptions,
} from "../claude/ISessionLauncher";
import type { IHttpClient } from "../ollama/IHttpClient";
import type { OpenRouterModelRegistry } from "./OpenRouterModelRegistry";

const OPENROUTER_CHAT_URL = "https://openrouter.ai/api/v1/chat/completions";
const DEFAULT_TIMEOUT_MS = 2 * 60 * 1000; // 2 minutes

interface OpenRouterMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

interface OpenRouterResponse {
  choices?: Array<{
    message?: {
      content?: string;
    };
  }>;
  error?: {
    message?: string;
    code?: number | string;
  };
}

/**
 * ISessionLauncher that calls OpenRouter's OpenAI-compatible API and
 * cycles through free models when rate-limited (429) or when a model
 * is unavailable (404/model-not-found).
 *
 * Model selection is delegated to OpenRouterModelRegistry, which fetches
 * and ranks free text models from the OpenRouter API and provides
 * round-robin cycling via advanceModel().
 *
 * Config shape (config.json):
 *   { "sessionLauncher": "openrouter", "openrouter": { "keyPath": "/path/to/openrouter.key" } }
 *
 * Optional model pin (bypasses registry cycling):
 *   { "openrouter": { "keyPath": "...", "model": "meta-llama/llama-3.3-70b-instruct:free" } }
 */
export class OpenRouterSessionLauncher implements ISessionLauncher {
  constructor(
    private readonly httpClient: IHttpClient,
    private readonly clock: IClock,
    private readonly apiKey: string,
    private readonly registry: OpenRouterModelRegistry,
    private readonly pinnedModel?: string,
  ) {}

  async launch(
    request: ClaudeSessionRequest,
    options?: LaunchOptions,
  ): Promise<ClaudeSessionResult> {
    if (!this.apiKey) {
      return {
        rawOutput: "",
        exitCode: 1,
        durationMs: 0,
        success: false,
        error: "OpenRouter API key not configured — set openrouter.keyPath in config.json",
      };
    }

    // Only honour options.model if it looks like an OpenRouter model ID (contains "/").
    // Claude/Gemini model strings like "claude-sonnet-4-6" are not valid here.
    const optionsModel = options?.model?.includes("/") ? options.model : undefined;
    const model = optionsModel ?? this.pinnedModel ?? (await this.resolveModel());
    if (!model) {
      return {
        rawOutput: "",
        exitCode: 1,
        durationMs: 0,
        success: false,
        error: "OpenRouter: no free text models available — check API key or try again later",
      };
    }

    const startMs = this.clock.now().getTime();
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;

    const messages: OpenRouterMessage[] = [];
    if (request.systemPrompt) {
      messages.push({ role: "system", content: request.systemPrompt });
    }
    messages.push({ role: "user", content: request.message });

    try {
      const response = await this.httpClient.post(
        OPENROUTER_CHAT_URL,
        { model, messages },
        {
          timeoutMs,
          headers: {
            Authorization: `Bearer ${this.apiKey}`,
            "HTTP-Referer": "https://github.com/anthropics/substrate",
            "X-Title": "Substrate",
          },
        },
      );

      const durationMs = this.clock.now().getTime() - startMs;

      if (response.status === 429 || response.status === 503) {
        this.registry.advanceModel();
        const errorText = await response.text();
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `OpenRouter rate-limited on ${model} (HTTP ${response.status}); rotated to next model. ${this.redactKey(errorText)}`,
        };
      }

      if (!response.ok) {
        const errorText = await response.text();
        const isModelError =
          response.status === 404 ||
          /model.*not found|invalid model|unknown model/i.test(errorText);
        if (isModelError) {
          this.registry.advanceModel();
        }
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `OpenRouter returned HTTP ${response.status}: ${this.redactKey(errorText)}`,
        };
      }

      const data = (await response.json()) as OpenRouterResponse;

      if (data.error) {
        const msg = data.error.message ?? JSON.stringify(data.error);
        return {
          rawOutput: "",
          exitCode: 1,
          durationMs,
          success: false,
          error: `OpenRouter API error: ${this.redactKey(msg)}`,
        };
      }

      const text = data.choices?.[0]?.message?.content ?? "";

      return {
        rawOutput: text,
        exitCode: 0,
        durationMs,
        success: true,
        usage: {
          provider: "openrouter",
          model,
          costKnown: true,
          costEstimate: false,
          billingSource: "free_tier",
          telemetrySource: "openrouter-api",
        },
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
          ? `Cannot reach OpenRouter at ${OPENROUTER_CHAT_URL} — check network. (${this.redactKey(message)})`
          : this.redactKey(message),
      };
    }
  }

  private async resolveModel(): Promise<string | undefined> {
    const models = await this.registry.getModels();
    if (models.length === 0) return undefined;
    return this.registry.currentModel();
  }

  private redactKey(text: string): string {
    if (!this.apiKey) return text;
    return text.replaceAll(this.apiKey, "[REDACTED]");
  }
}
