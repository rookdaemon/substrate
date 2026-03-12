import { VertexSessionLauncher, DEFAULT_VERTEX_MODEL } from "../../../src/agents/vertex/VertexSessionLauncher";
import { InMemoryHttpClient } from "../../../src/agents/ollama/InMemoryHttpClient";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import type { ClaudeSessionRequest } from "../../../src/agents/claude/ISessionLauncher";

const TEST_API_KEY = "test-api-key-12345";

function makeRequest(overrides?: Partial<ClaudeSessionRequest>): ClaudeSessionRequest {
  return {
    systemPrompt: "",
    message: "Summarize this conversation.",
    ...overrides,
  };
}

function makeGoogleAIResponse(text: string) {
  return {
    candidates: [
      {
        content: {
          parts: [{ text }],
        },
      },
    ],
  };
}

function makeGoogleAIError(code: number, message: string) {
  return {
    error: { code, message, status: "INVALID_ARGUMENT" },
  };
}

describe("VertexSessionLauncher", () => {
  let http: InMemoryHttpClient;
  let clock: FixedClock;
  let launcher: VertexSessionLauncher;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));
    launcher = new VertexSessionLauncher(http, clock, TEST_API_KEY);
  });

  // ── URL and API key routing ─────────────────────────────────────────────

  it("posts to Google AI generateContent endpoint with API key", async () => {
    http.enqueueJson(makeGoogleAIResponse("summary"));

    await launcher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.url).toContain("generativelanguage.googleapis.com/v1beta/models/");
    expect(req.url).toContain(`:generateContent?key=${TEST_API_KEY}`);
  });

  it("uses default model (gemini-2.5-flash) in URL", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await launcher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.url).toContain(`/models/${DEFAULT_VERTEX_MODEL}:`);
  });

  it("uses constructor model when provided", async () => {
    const customLauncher = new VertexSessionLauncher(http, clock, TEST_API_KEY, "gemini-1.5-flash");
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await customLauncher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.url).toContain("/models/gemini-1.5-flash:");
  });

  it("uses options.model when provided, overriding constructor model", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await launcher.launch(makeRequest(), { model: "gemini-2.0-flash" });

    const [req] = http.getRequests();
    expect(req.url).toContain("/models/gemini-2.0-flash:");
  });

  it("ignores non-Google model in options and falls back to constructor model", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await launcher.launch(makeRequest(), { model: "claude-sonnet-4-6" });

    const [req] = http.getRequests();
    expect(req.url).toContain(`/models/${DEFAULT_VERTEX_MODEL}:`);
  });

  it("accepts gemma- prefixed model in options", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await launcher.launch(makeRequest(), { model: "gemma-3-27b-it" });

    const [req] = http.getRequests();
    expect(req.url).toContain("/models/gemma-3-27b-it:");
  });

  // ── Request body structure ──────────────────────────────────────────────

  it("sends user message in contents array", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await launcher.launch(makeRequest({ message: "Hello world" }));

    const body = http.getRequests()[0].body as Record<string, unknown>;
    const contents = body.contents as Array<{ role: string; parts: Array<{ text: string }> }>;
    expect(contents).toHaveLength(1);
    expect(contents[0].role).toBe("user");
    expect(contents[0].parts[0].text).toBe("Hello world");
  });

  it("sends systemInstruction when systemPrompt is non-empty", async () => {
    http.enqueueJson(makeGoogleAIResponse("result"));

    await launcher.launch(makeRequest({
      systemPrompt: "You are a summarizer.",
      message: "Summarize this.",
    }));

    const body = http.getRequests()[0].body as Record<string, unknown>;
    const si = body.systemInstruction as { parts: Array<{ text: string }> };
    expect(si).toBeDefined();
    expect(si.parts[0].text).toBe("You are a summarizer.");
  });

  it("omits systemInstruction when systemPrompt is empty", async () => {
    http.enqueueJson(makeGoogleAIResponse("result"));

    await launcher.launch(makeRequest({ systemPrompt: "", message: "Hello" }));

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.systemInstruction).toBeUndefined();
  });

  // ── Success and failure responses ──────────────────────────────────────

  it("returns rawOutput and success=true on HTTP 200", async () => {
    http.enqueueJson(makeGoogleAIResponse("This is the summary."));

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe("This is the summary.");
    expect(result.error).toBeUndefined();
  });

  it("returns success=false with HTTP status on non-200 response", async () => {
    http.enqueueError(403, "API key invalid");

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("403");
    expect(result.rawOutput).toBe("");
  });

  it("returns success=false with error message from API error response", async () => {
    http.enqueueJson(makeGoogleAIError(400, "Request contains an invalid argument"));

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain("invalid argument");
  });

  it("returns empty string when candidates array is empty", async () => {
    http.enqueueJson({ candidates: [] });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe("");
  });

  it("handles network errors gracefully (never throws)", async () => {
    http.enqueueNetworkError("connect ECONNREFUSED 142.250.0.0:443");

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Google AI request failed");
  });

  it("reports durationMs via clock (FixedClock → 0ms)", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    const result = await launcher.launch(makeRequest());

    expect(result.durationMs).toBe(0);
  });

  // ── API key redaction ──────────────────────────────────────────────────

  it("redacts API key from error messages", async () => {
    http.enqueueError(401, `Invalid API key: ${TEST_API_KEY}`);

    const result = await launcher.launch(makeRequest());

    expect(result.error).not.toContain(TEST_API_KEY);
    expect(result.error).toContain("[REDACTED]");
  });

  it("redacts API key from network error messages", async () => {
    http.enqueueNetworkError(`fetch to https://api.example.com?key=${TEST_API_KEY} failed`);

    const result = await launcher.launch(makeRequest());

    expect(result.error).not.toContain(TEST_API_KEY);
    expect(result.error).toContain("[REDACTED]");
  });

  // ── Health probe ──────────────────────────────────────────────────────

  it("healthy() returns true when API responds with 200", async () => {
    http.enqueueJson({ models: [{ name: "gemini-2.5-flash" }] });

    const result = await launcher.healthy();

    expect(result).toBe(true);
    const [req] = http.getRequests();
    expect(req.method).toBe("GET");
    expect(req.url).toContain("/models?key=");
  });

  it("healthy() returns false when API responds with error", async () => {
    http.enqueueError(403, "Forbidden");

    const result = await launcher.healthy();

    expect(result).toBe(false);
  });

  it("healthy() returns false on network error", async () => {
    http.enqueueNetworkError("DNS resolution failed");

    const result = await launcher.healthy();

    expect(result).toBe(false);
  });

  // ── Timeout ──────────────────────────────────────────────────────────

  it("passes default timeout (2 min) to HTTP client", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await launcher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.options?.timeoutMs).toBe(2 * 60 * 1000);
  });

  it("uses custom timeout from options", async () => {
    http.enqueueJson(makeGoogleAIResponse("ok"));

    await launcher.launch(makeRequest(), { timeoutMs: 30000 });

    const [req] = http.getRequests();
    expect(req.options?.timeoutMs).toBe(30000);
  });
});
