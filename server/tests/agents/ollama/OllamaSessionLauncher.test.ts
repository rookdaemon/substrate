import { OllamaSessionLauncher, DEFAULT_MODEL, DEFAULT_BASE_URL } from "../../../src/agents/ollama/OllamaSessionLauncher";
import { InMemoryHttpClient } from "../../../src/agents/ollama/InMemoryHttpClient";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import type { ClaudeSessionRequest } from "../../../src/agents/claude/ISessionLauncher";

function makeRequest(overrides?: Partial<ClaudeSessionRequest>): ClaudeSessionRequest {
  return {
    systemPrompt: "",
    message: "Execute this task.",
    ...overrides,
  };
}

function makeOllamaResponse(content: string) {
  return {
    model: DEFAULT_MODEL,
    message: { role: "assistant", content },
    done: true,
    total_duration: 100000000,
    eval_count: 42,
  };
}

describe("OllamaSessionLauncher", () => {
  let http: InMemoryHttpClient;
  let clock: FixedClock;
  let launcher: OllamaSessionLauncher;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));
    launcher = new OllamaSessionLauncher(http, clock);
  });

  // ── URL and model routing ────────────────────────────────────────────────

  it("posts to /api/chat on the default base URL", async () => {
    http.enqueueJson(makeOllamaResponse("ok"));

    await launcher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.url).toBe(`${DEFAULT_BASE_URL}/api/chat`);
  });

  it("uses a custom base URL when provided", async () => {
    const customLauncher = new OllamaSessionLauncher(
      http,
      clock,
      undefined,
      "http://nova-host:11434"
    );
    http.enqueueJson(makeOllamaResponse("ok"));

    await customLauncher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.url).toBe("http://nova-host:11434/api/chat");
  });

  it("strips trailing slash from base URL", async () => {
    const customLauncher = new OllamaSessionLauncher(
      http,
      clock,
      undefined,
      "http://nova-host:11434/"
    );
    http.enqueueJson(makeOllamaResponse("ok"));

    await customLauncher.launch(makeRequest());

    expect(http.getRequests()[0].url).toBe("http://nova-host:11434/api/chat");
  });

  it("uses default model in request body", async () => {
    http.enqueueJson(makeOllamaResponse("ok"));

    await launcher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe(DEFAULT_MODEL);
  });

  it("uses constructor model when no options.model provided", async () => {
    const customLauncher = new OllamaSessionLauncher(http, clock, "llama3.1:8b");
    http.enqueueJson(makeOllamaResponse("ok"));

    await customLauncher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe("llama3.1:8b");
  });

  it("uses options.model when provided, overriding constructor model", async () => {
    http.enqueueJson(makeOllamaResponse("ok"));

    await launcher.launch(makeRequest(), { model: "phi4:14b" });

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe("phi4:14b");
  });

  it("sets stream: false in the request body", async () => {
    http.enqueueJson(makeOllamaResponse("ok"));

    await launcher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.stream).toBe(false);
  });

  // ── JSON format enforcement ──────────────────────────────────────────────

  it("sends format: 'json' by default (fallback JSON reliability)", async () => {
    http.enqueueJson(makeOllamaResponse('{"result":"success"}'));

    await launcher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.format).toBe("json");
  });

  it("sends the outputSchema as format when provided via options", async () => {
    const schema = {
      type: "object",
      properties: { result: { type: "string" } },
      required: ["result"],
    };
    http.enqueueJson(makeOllamaResponse('{"result":"success"}'));

    await launcher.launch(makeRequest(), { outputSchema: schema });

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.format).toEqual(schema);
  });

  // ── System prompt handling ───────────────────────────────────────────────

  it("sends system message first when systemPrompt is non-empty", async () => {
    http.enqueueJson(makeOllamaResponse("result"));

    await launcher.launch(
      makeRequest({ systemPrompt: "You are an agent.", message: "Do the task." })
    );

    const messages = (http.getRequests()[0].body as Record<string, unknown>)
      .messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("You are an agent.");
    expect(messages[1].role).toBe("user");
    expect(messages[1].content).toBe("Do the task.");
  });

  it("omits system message when systemPrompt is empty", async () => {
    http.enqueueJson(makeOllamaResponse("result"));

    await launcher.launch(makeRequest({ systemPrompt: "", message: "Hello" }));

    const messages = (http.getRequests()[0].body as Record<string, unknown>)
      .messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  // ── Success and failure responses ────────────────────────────────────────

  it("returns rawOutput and success=true on HTTP 200", async () => {
    http.enqueueJson(makeOllamaResponse('{"result":"success","summary":"done"}'));

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe('{"result":"success","summary":"done"}');
    expect(result.error).toBeUndefined();
  });

  it("returns success=false with HTTP status in error on non-200 response", async () => {
    http.enqueueError(404, "model not found");

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.exitCode).toBe(1);
    expect(result.error).toContain("404");
    expect(result.rawOutput).toBe("");
  });

  it("returns success=false with Ollama error field when present", async () => {
    http.enqueueJson({ error: "model 'no-such-model' not found, try pulling it first" });

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain("no-such-model");
  });

  it("returns a connection hint on ECONNREFUSED", async () => {
    http.enqueueNetworkError("connect ECONNREFUSED 127.0.0.1:11434");

    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toContain("Cannot reach Ollama");
    expect(result.error).toContain(DEFAULT_BASE_URL);
  });

  it("reports durationMs via clock (FixedClock → 0ms)", async () => {
    http.enqueueJson(makeOllamaResponse("ok"));

    const result = await launcher.launch(makeRequest());

    expect(result.durationMs).toBe(0);
  });

  // ── Session continuity ───────────────────────────────────────────────────

  it("starts a fresh session (no history) when continueSession is false", async () => {
    http.enqueueJson(makeOllamaResponse("turn 1"));
    await launcher.launch(
      makeRequest({ message: "turn 1" }),
      { continueSession: false }
    );

    http.enqueueJson(makeOllamaResponse("turn 2"));
    await launcher.launch(
      makeRequest({ message: "turn 2" }),
      { continueSession: false }
    );

    // Second request should only have the new user message (no history)
    const messages2 = (http.getRequests()[1].body as Record<string, unknown>)
      .messages as Array<{ role: string; content: string }>;
    expect(messages2).toHaveLength(1);
    expect(messages2[0].content).toBe("turn 2");
  });

  it("accumulates history across turns when continueSession is true", async () => {
    http.enqueueJson(makeOllamaResponse("assistant turn 1"));
    await launcher.launch(
      makeRequest({ systemPrompt: "sys", message: "user turn 1" }),
      { continueSession: true }
    );

    http.enqueueJson(makeOllamaResponse("assistant turn 2"));
    await launcher.launch(
      makeRequest({ message: "user turn 2" }),
      { continueSession: true }
    );

    const messages2 = (http.getRequests()[1].body as Record<string, unknown>)
      .messages as Array<{ role: string; content: string }>;

    // Should contain: system, user 1, assistant 1, user 2
    expect(messages2).toHaveLength(4);
    expect(messages2[0]).toEqual({ role: "system", content: "sys" });
    expect(messages2[1]).toEqual({ role: "user", content: "user turn 1" });
    expect(messages2[2]).toEqual({ role: "assistant", content: "assistant turn 1" });
    expect(messages2[3]).toEqual({ role: "user", content: "user turn 2" });
  });

  it("exposes historyLength reflecting accumulated messages", async () => {
    expect(launcher.historyLength).toBe(0);

    http.enqueueJson(makeOllamaResponse("r1"));
    await launcher.launch(makeRequest({ systemPrompt: "s", message: "m1" }), {
      continueSession: true,
    });
    // system + user + assistant = 3
    expect(launcher.historyLength).toBe(3);

    http.enqueueJson(makeOllamaResponse("r2"));
    await launcher.launch(makeRequest({ message: "m2" }), { continueSession: true });
    // +user + assistant = 5
    expect(launcher.historyLength).toBe(5);
  });

  it("resets history after resetHistory()", async () => {
    http.enqueueJson(makeOllamaResponse("r1"));
    await launcher.launch(makeRequest({ message: "m1" }), { continueSession: true });
    expect(launcher.historyLength).toBeGreaterThan(0);

    launcher.resetHistory();
    expect(launcher.historyLength).toBe(0);
  });

  it("history is not updated on a failed response", async () => {
    http.enqueueError(500, "internal error");
    await launcher.launch(makeRequest({ message: "m1" }), { continueSession: true });

    expect(launcher.historyLength).toBe(0);
  });
});
