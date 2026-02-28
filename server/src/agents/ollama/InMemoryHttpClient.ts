import type { IHttpClient, HttpResponse, HttpRequestOptions } from "./IHttpClient";

export interface RecordedRequest {
  url: string;
  body: unknown;
  options?: HttpRequestOptions;
}

interface QueuedResponse {
  ok: boolean;
  status: number;
  body: unknown; // Will be returned by both .text() and .json()
}

/**
 * In-memory IHttpClient for unit tests.
 * Enqueue responses in order; each launch() call consumes one.
 *
 * @author Nova Daemon
 */
export class InMemoryHttpClient implements IHttpClient {
  private readonly responses: QueuedResponse[] = [];
  private readonly requests: RecordedRequest[] = [];

  enqueueJson(body: unknown, status = 200): void {
    this.responses.push({ ok: status >= 200 && status < 300, status, body });
  }

  enqueueError(status: number, body: string): void {
    this.responses.push({ ok: false, status, body });
  }

  enqueueNetworkError(message: string): void {
    // Stored as a special sentinel — post() will throw
    this.responses.push({ ok: false, status: -1, body: message });
  }

  getRequests(): RecordedRequest[] {
    return [...this.requests];
  }

  reset(): void {
    this.responses.length = 0;
    this.requests.length = 0;
  }

  async post(
    url: string,
    body: unknown,
    options?: HttpRequestOptions
  ): Promise<HttpResponse> {
    this.requests.push({ url, body, options });

    const queued = this.responses.shift();
    if (!queued) {
      throw new Error("InMemoryHttpClient: no more queued responses");
    }

    // Simulate a network error
    if (queued.status === -1) {
      const err = new Error(queued.body as string);
      (err as NodeJS.ErrnoException).code = "ECONNREFUSED";
      throw err;
    }

    const serialized =
      typeof queued.body === "string"
        ? queued.body
        : JSON.stringify(queued.body);

    return {
      ok: queued.ok,
      status: queued.status,
      text: async () => serialized,
      json: async () =>
        typeof queued.body === "string" ? JSON.parse(queued.body) : queued.body,
    };
  }
}
