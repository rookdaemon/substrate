import { OpenRouterSessionLauncher } from "../../../src/agents/openrouter/OpenRouterSessionLauncher";
import { OpenRouterModelRegistry } from "../../../src/agents/openrouter/OpenRouterModelRegistry";
import { InMemoryHttpClient } from "../../../src/agents/ollama/InMemoryHttpClient";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import type { ClaudeSessionRequest } from "../../../src/agents/claude/ISessionLauncher";

const FAKE_KEY = "sk-or-test-key";
const FAKE_MODEL = "meta-llama/llama-3.3-70b-instruct:free";

function makeRequest(overrides?: Partial<ClaudeSessionRequest>): ClaudeSessionRequest {
  return {
    systemPrompt: "",
    message: "Execute this task.",
    ...overrides,
  };
}

function makeChatResponse(content: string) {
  return {
    id: "gen-test",
    model: FAKE_MODEL,
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

/**
 * Build a registry that is already seeded with a model list via priorityModels
 * and has already fetched (so it won't consume HTTP responses from the launcher's client).
 * The registry gets its own isolated HTTP client.
 */
function makeSeededRegistry(clock: FixedClock, models: string[] = [FAKE_MODEL]): OpenRouterModelRegistry {
  const registryHttp = new InMemoryHttpClient();
  // Enqueue a dummy 200 with the priority models already present — fetch will merge them
  registryHttp.enqueueJson({ data: models.map((id) => ({
    id,
    context_length: 8192,
    architecture: { modality: "text->text" },
    pricing: { prompt: "0", completion: "0" },
  })) });
  return new OpenRouterModelRegistry(registryHttp, clock, FAKE_KEY, models);
}

describe("OpenRouterSessionLauncher", () => {
  let http: InMemoryHttpClient;
  let clock: FixedClock;
  let registry: OpenRouterModelRegistry;

  beforeEach(async () => {
    http = new InMemoryHttpClient();
    clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));
    registry = makeSeededRegistry(clock);
    // Prime the registry so it doesn't consume chat-completion responses
    await registry.getModels();
  });

  // ── Missing key ────────────────────────────────────────────────────────────

  it("returns failure when API key is empty", async () => {
    const launcher = new OpenRouterSessionLauncher(http, clock, "", registry);
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/api key not configured/i);
  });

  // ── Request format ─────────────────────────────────────────────────────────

  it("POSTs to the OpenRouter chat completions endpoint", async () => {
    http.enqueueJson(makeChatResponse("done"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    await launcher.launch(makeRequest());

    const [req] = http.getRequests();
    expect(req.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    expect(req.method).toBe("POST");
  });

  it("includes system prompt as first message when provided", async () => {
    http.enqueueJson(makeChatResponse("ok"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    await launcher.launch(makeRequest({ systemPrompt: "You are a helpful agent." }));

    const body = http.getRequests()[0].body as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string; content: string }>;
    expect(messages[0].role).toBe("system");
    expect(messages[0].content).toBe("You are a helpful agent.");
    expect(messages[1].role).toBe("user");
  });

  it("omits system message when systemPrompt is empty", async () => {
    http.enqueueJson(makeChatResponse("ok"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    await launcher.launch(makeRequest({ systemPrompt: "" }));

    const body = http.getRequests()[0].body as Record<string, unknown>;
    const messages = body.messages as Array<{ role: string }>;
    expect(messages).toHaveLength(1);
    expect(messages[0].role).toBe("user");
  });

  it("sends the model from the registry", async () => {
    http.enqueueJson(makeChatResponse("ok"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    await launcher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe(FAKE_MODEL);
  });

  it("uses pinned model when set, ignoring registry", async () => {
    const pinned = "qwen/qwen3-235b-a22b:free";
    http.enqueueJson(makeChatResponse("ok"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry, pinned);
    await launcher.launch(makeRequest());

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe(pinned);
  });

  it("options.model overrides both pinned and registry model", async () => {
    const override = "nvidia/nemotron-3-ultra-550b-a55b:free";
    http.enqueueJson(makeChatResponse("ok"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    await launcher.launch(makeRequest(), { model: override });

    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.model).toBe(override);
  });

  // ── Auth header ────────────────────────────────────────────────────────────

  it("sends Authorization: Bearer header", async () => {
    http.enqueueJson(makeChatResponse("ok"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    await launcher.launch(makeRequest());

    const headers = (http.getRequests()[0].options as Record<string, unknown>)?.headers as Record<string, string>;
    expect(headers.Authorization).toBe(`Bearer ${FAKE_KEY}`);
  });

  // ── Success ────────────────────────────────────────────────────────────────

  it("returns success with rawOutput on 200 response", async () => {
    http.enqueueJson(makeChatResponse("Task completed successfully."));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(true);
    expect(result.exitCode).toBe(0);
    expect(result.rawOutput).toBe("Task completed successfully.");
    expect(result.error).toBeUndefined();
  });

  it("reports provider as openrouter in usage", async () => {
    http.enqueueJson(makeChatResponse("ok"));
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    const result = await launcher.launch(makeRequest());

    expect(result.usage?.provider).toBe("openrouter");
    expect(result.usage?.billingSource).toBe("free_tier");
  });

  // ── Rate limiting → model cycling ─────────────────────────────────────────

  it("advances the registry model on 429 and returns failure", async () => {
    const twoRegistry = makeSeededRegistry(clock, [FAKE_MODEL, "second:free"]);
    await twoRegistry.getModels();

    http.enqueueError(429, "rate limited");
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, twoRegistry);
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/rate-limit/i);
    expect(twoRegistry.currentModel()).toBe("second:free");
  });

  it("advances the registry model on 503", async () => {
    const twoRegistry = makeSeededRegistry(clock, [FAKE_MODEL, "second:free"]);
    await twoRegistry.getModels();

    http.enqueueError(503, "service unavailable");
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, twoRegistry);
    await launcher.launch(makeRequest());

    expect(twoRegistry.currentModel()).toBe("second:free");
  });

  it("advances the registry model on 404 model-not-found", async () => {
    const twoRegistry = makeSeededRegistry(clock, [FAKE_MODEL, "second:free"]);
    await twoRegistry.getModels();

    http.enqueueError(404, "Model not found");
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, twoRegistry);
    await launcher.launch(makeRequest());

    expect(twoRegistry.currentModel()).toBe("second:free");
  });

  // ── API-level errors ───────────────────────────────────────────────────────

  it("returns failure on non-200 HTTP status", async () => {
    http.enqueueError(500, "internal server error");
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/HTTP 500/);
  });

  it("returns failure when response has error field", async () => {
    http.enqueueJson({ error: { message: "model overloaded", code: 503 } });
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/model overloaded/);
  });

  // ── Network errors ─────────────────────────────────────────────────────────

  it("returns failure on network error (ECONNREFUSED)", async () => {
    http.enqueueNetworkError("connect ECONNREFUSED");
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/cannot reach openrouter/i);
  });

  // ── Key redaction ──────────────────────────────────────────────────────────

  it("redacts API key from error messages", async () => {
    http.enqueueError(401, `invalid key: ${FAKE_KEY} is not valid`);
    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, registry);
    const result = await launcher.launch(makeRequest());

    expect(result.error).not.toContain(FAKE_KEY);
    expect(result.error).toContain("[REDACTED]");
  });

  // ── No available models ────────────────────────────────────────────────────

  it("returns failure when registry has no models", async () => {
    const emptyRegistryHttp = new InMemoryHttpClient();
    emptyRegistryHttp.enqueueNetworkError("ECONNREFUSED");
    const emptyRegistry = new OpenRouterModelRegistry(emptyRegistryHttp, clock, FAKE_KEY);
    await emptyRegistry.getModels(); // prime — will fail, leaving empty

    const launcher = new OpenRouterSessionLauncher(http, clock, FAKE_KEY, emptyRegistry);
    const result = await launcher.launch(makeRequest());

    expect(result.success).toBe(false);
    expect(result.error).toMatch(/no free text models/i);
  });
});
