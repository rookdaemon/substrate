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
        headers: { "Content-Type": "application/json", ...options?.headers },
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

  async postStream(
    url: string,
    body: unknown,
    options?: HttpRequestOptions
  ): Promise<AsyncIterable<string>> {
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      options?.timeoutMs ?? DEFAULT_TIMEOUT_MS
    );
    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json", ...options?.headers },
      body: JSON.stringify(body),
      signal: controller.signal,
    });
    if (!response.ok) {
      clearTimeout(timeout);
      throw new Error(`HTTP ${response.status}`);
    }
    if (!response.body) {
      clearTimeout(timeout);
      throw new Error(`HTTP ${response.status}: response body is not readable`);
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    return (async function* () {
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() ?? "";
          for (const line of lines) {
            if (line.trim()) yield line;
          }
        }
        if (buffer.trim()) yield buffer;
      } finally {
        clearTimeout(timeout);
        reader.releaseLock();
      }
    })();
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
