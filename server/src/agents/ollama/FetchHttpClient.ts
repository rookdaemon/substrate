import type { IHttpClient, HttpResponse, HttpRequestOptions } from "./IHttpClient";

const DEFAULT_TIMEOUT_MS = 5 * 60 * 1000; // 5 minutes — local inference can be slow

/**
 * Real IHttpClient implementation using the Node.js built-in fetch API
 * (available since Node 18, stable in Node 21+).
 *
 * @author Nova Daemon
 */
export class FetchHttpClient implements IHttpClient {
  async post(
    url: string,
    body: unknown,
    options?: HttpRequestOptions
  ): Promise<HttpResponse> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
        json: () => response.json(),
      };
    } finally {
      clearTimeout(timer);
    }
  }

  async get(
    url: string,
    options?: HttpRequestOptions
  ): Promise<HttpResponse> {
    const timeoutMs = options?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
      const response = await fetch(url, {
        method: "GET",
        signal: controller.signal,
      });

      return {
        ok: response.ok,
        status: response.status,
        text: () => response.text(),
        json: () => response.json(),
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
