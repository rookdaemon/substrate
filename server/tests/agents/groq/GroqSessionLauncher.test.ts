import {
  GroqSessionLauncher,
  DEFAULT_GROQ_MODEL,
} from "../../../src/agents/groq/GroqSessionLauncher";
import { InMemoryHttpClient } from "../../../src/agents/ollama/InMemoryHttpClient";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import type { ClaudeSessionRequest } from "../../../src/agents/claude/ISessionLauncher";

const FAKE_API_KEY = "gsk_test_key_1234567890";

function makeRequest(
  overrides?: Partial<ClaudeSessionRequest>,
): ClaudeSessionRequest {
  return {
    systemPrompt: "",
    message: "Execute this task.",
    ...overrides,
  };
}

function makeGroqResponse(content: string) {
  return {
    id: "chatcmpl-test",
    object: "chat.completion",
    model: DEFAULT_GROQ_MODEL,
    choices: [
      {
        index: 0,
        message: { role: "assistant", content },
        finish_reason: "stop",
      },
    ],
    usage: { prompt_tokens: 10, completion_tokens: 20, total_tokens: 30 },
  };
}

describe("GroqSessionLauncher", () => {
  let http: InMemoryHttpClient;
  let clock: FixedClock;
  let launcher: GroqSessionLauncher;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));
    launcher = new GroqSessionLauncher(http, clock, FAKE_API_KEY);
  });

  // ── Missing key ──────────────────────────────────────────────────────────

  it("does not throw when constructed with an empty apiKey", () => {
    expect(() => new GroqSessionLauncher(http, clock, "")).not.toThrow();
  });

  it("returns success=false with descriptive error when apiKey is empty", async () => {
    const emptyKeyLauncher = new GroqSessionLauncher(http, clock, "");
    const result = await emptyKeyLauncher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("GROQ API key not configured");
    expect(http.getRequests()).toHaveLength(0);
  });

  // ── URL and model routing ────────────────────────────────────────────────

  it("posts to Groq chat/completions endpoint", async () => {
    http.enqueueJson(makeGroqResponse("ok"));

    await launcher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.url).toBe("https://api.groq.com/openai/v1/chat/completions");
  });

  it("uses default model in request body", async () => {
    http.enqueueJson(makeGroqResponse("ok"));

    await launcher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_GROQ_MODEL);
  });

  it("uses constructor model when no options.model provided", async () => {
    const customLauncher = new GroqSessionLauncher(
      http,
      clock,
      FAKE_API_KEY,
      "llama3-8b-8192",
    );
    http.enqueueJson(makeGroqResponse("ok"));

    await customLauncher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe("llama3-8b-8192");
  });

  it("uses options.model when provided, overriding constructor model", async () => {
    http.enqueueJson(makeGroqResponse("ok"));

    await launcher.launch(makeRequest(), { model: "mixtral-8x7b-32768" });

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe("mixtral-8x7b-32768");
  });

  // ── Auth header ──────────────────────────────────────────────────────────

  it("sends Authorization Bearer header with key from file", async () => {
    http.enqueueJson(makeGroqResponse("ok"));

    await launcher.launch(makeRequest());

    const [req] = http.getRequests();
    expect((req.options as Record<string, unknown>)?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${FAKE_API_KEY}` }),
    );
  });

  // ── System prompt handling ───────────────────────────────────────────────

  it("sends system message first when systemPrompt is non-empty", async () => {
    http.enqueueJson(makeGroqResponse("result"));

    await launcher.launch(
      makeRequest({ systemPrompt: "You are an agent.", message: "Do the task." }),
    );

    const messages = (http.getRequests()[0].body as Record<string, unknown>)
      .messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("You are an agent.");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Do the task.");
  });

  it("omits system message when systemPrompt is empty", async () => {
    http.enqueueJson(makeGroqResponse("result"));

    await launcher.launch(makeRequest({ systemPrompt: "", message: "Hello" }));

    const messages = (http.getRequests()[0].body as Record<string, unknown>)
      .messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  // ── Success case ─────────────────────────────────────────────────────────

  it("returns rawOutput and success=true on HTTP 200", async () => {
    http.enqueueJson(makeGroqResponse('{"result":"success"}'));

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe('{"result":"success"}');
    expect(result.error).toBeUndefined();
  });

  it("reports durationMs via clock (FixedClock → 0ms)", async () => {
    http.enqueueJson(makeGroqResponse("ok"));

    const result = await launcher.launch(makeRequest());

    expect(result.durationMs).toBe(0);
  });

  // ── Error cases ──────────────────────────────────────────────────────────

  it("returns success=false with HTTP status in error on non-200 response", async () => {
    http.enqueueError(401, "invalid_api_key");

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("401");
    expect(result.rawOutput).toBe("");
  });

  it("returns success=false with Groq error field when present", async () => {
    http.enqueueJson({
      error: {
        message: "Rate limit exceeded",
        type: "rate_limit_exceeded",
        code: "rate_limit_exceeded",
      },
    });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Rate limit exceeded");
  });

  it("returns success=false on network error", async () => {
    http.enqueueNetworkError("connect ECONNREFUSED 104.18.6.88:443");

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("Cannot reach Groq API");
  });

  it("does not leak API key in error messages", async () => {
    http.enqueueError(401, `Invalid key: ${FAKE_API_KEY}`);

    const result = await launcher.launch(makeRequest());

    expect(result.error).not.toContain(FAKE_API_KEY);
    expect(result.error).toContain("[REDACTED]");
  });
});
