import type { IHttpClient } from "./IHttpClient";
import type { ILogger } from "../../logging";

/**
 * Result of an Ollama inference call.
 * Never throws — always returns a result object.
 */
export type InferenceResult =
  | { ok: true; result: string }
  | { ok: false; reason: "unavailable" | "parse_error" | "timeout" };

/**
 * Interface for Ollama inference — allows test doubles.
 */
export interface IOllamaInferenceClient {
  infer(prompt: string, model?: string): Promise<InferenceResult>;
  probe(): Promise<boolean>;
}

/**
 * Lightweight Ollama inference client.
 * Calls /api/generate for text generation and /api/tags for health probes.
 * Never throws — all errors are captured in the result type.
 *
 * @see https://github.com/ollama/ollama/blob/main/docs/api.md
 */
export class OllamaInferenceClient implements IOllamaInferenceClient {
  constructor(
    private readonly httpClient: IHttpClient,
    private readonly baseUrl: string,
    private readonly defaultModel: string = "qwen3:14b",
    private readonly logger?: ILogger,
    private readonly apiKey?: string,
  ) {}

  /**
   * Run inference against Ollama's /api/generate endpoint.
   * Returns the generated text on success, or a typed error on failure.
   */
  async infer(prompt: string, model?: string): Promise<InferenceResult> {
    const targetModel = model ?? this.defaultModel;
    const authHeaders = this.apiKey
      ? { Authorization: `Bearer ${this.apiKey}` }
      : undefined;
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/generate`,
        { model: targetModel, prompt, stream: false },
        { timeoutMs: 120000, headers: authHeaders }, // 2 minutes for inference
      );

      if (!response.ok) {
        this.logger?.debug(`[OLLAMA] Inference failed: status=${response.status}`);
        return { ok: false, reason: "unavailable" };
      }

      const body = await response.json() as { response?: string };
      if (typeof body?.response !== "string") {
        this.logger?.debug(`[OLLAMA] Unexpected response shape: ${JSON.stringify(body).slice(0, 200)}`);
        return { ok: false, reason: "parse_error" };
      }

      return { ok: true, result: body.response };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (msg.includes("abort") || msg.includes("timeout")) {
        this.logger?.debug(`[OLLAMA] Inference timed out: ${msg}`);
        return { ok: false, reason: "timeout" };
      }
      this.logger?.debug(`[OLLAMA] Inference error: ${msg}`);
      return { ok: false, reason: "unavailable" };
    }
  }

  /**
   * Health probe: GET /api/tags — returns true if Ollama is reachable and responding.
   */
  async probe(): Promise<boolean> {
    const authHeaders = this.apiKey
      ? { Authorization: `Bearer ${this.apiKey}` }
      : undefined;
    try {
      const response = await this.httpClient.get(
        `${this.baseUrl}/api/tags`,
        { timeoutMs: 5000, headers: authHeaders },
      );
      return response.ok;
    } catch {
      return false;
    }
  }
}
