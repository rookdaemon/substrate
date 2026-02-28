/**
 * Minimal HTTP client abstraction for the Ollama session launcher.
 * Allows the real fetch-based implementation to be swapped for an
 * in-memory mock in unit tests.
 *
 * @author Nova Daemon
 */

export interface HttpResponse {
  ok: boolean;
  status: number;
  text(): Promise<string>;
  json(): Promise<unknown>;
}

export interface HttpRequestOptions {
  timeoutMs?: number;
}

export interface IHttpClient {
  post(
    url: string,
    body: unknown,
    options?: HttpRequestOptions
  ): Promise<HttpResponse>;

  get(
    url: string,
    options?: HttpRequestOptions
  ): Promise<HttpResponse>;
}
