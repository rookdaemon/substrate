import { OpenRouterModelRegistry } from "../../../src/agents/openrouter/OpenRouterModelRegistry";
import { InMemoryHttpClient } from "../../../src/agents/ollama/InMemoryHttpClient";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";

const FAKE_KEY = "sk-or-test-key";

function makeModelsResponse(models: Array<{
  id: string;
  context_length?: number;
  modality?: string;
  promptPrice?: string;
  completionPrice?: string;
}>) {
  return {
    data: models.map((m) => ({
      id: m.id,
      context_length: m.context_length ?? 8192,
      architecture: { modality: m.modality ?? "text->text" },
      pricing: {
        prompt: m.promptPrice ?? "0",
        completion: m.completionPrice ?? "0",
      },
    })),
  };
}

describe("OpenRouterModelRegistry", () => {
  let http: InMemoryHttpClient;
  let clock: FixedClock;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    clock = new FixedClock(new Date("2026-01-01T00:00:00Z"));
  });

  // ── Filtering ──────────────────────────────────────────────────────────────

  it("returns only free text models", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "free-model", context_length: 8192 },
      { id: "paid-model", promptPrice: "0.0001", completionPrice: "0.0001" },
      { id: "image-model", modality: "image->image", promptPrice: "0" },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    const models = await registry.getModels();

    expect(models).toEqual(["free-model"]);
  });

  it("excludes models with non-zero prompt price", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "paid", promptPrice: "0.0001", completionPrice: "0" },
      { id: "free", promptPrice: "0", completionPrice: "0" },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    const models = await registry.getModels();

    expect(models).toEqual(["free"]);
  });

  it("excludes models with non-zero completion price", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "paid", promptPrice: "0", completionPrice: "0.0001" },
      { id: "free", promptPrice: "0", completionPrice: "0" },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    const models = await registry.getModels();

    expect(models).toEqual(["free"]);
  });

  // ── Ranking ────────────────────────────────────────────────────────────────

  it("ranks free models by context length descending", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "small", context_length: 4096 },
      { id: "large", context_length: 131072 },
      { id: "medium", context_length: 32768 },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    const models = await registry.getModels();

    expect(models).toEqual(["large", "medium", "small"]);
  });

  // ── Priority models ────────────────────────────────────────────────────────

  it("places priorityModels before discovered models", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "discovered-a", context_length: 131072 },
      { id: "discovered-b", context_length: 32768 },
      { id: "priority-model", context_length: 4096 },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY, ["priority-model"]);
    const models = await registry.getModels();

    expect(models[0]).toBe("priority-model");
    expect(models).toContain("discovered-a");
    expect(models).toContain("discovered-b");
  });

  it("deduplicates priorityModels already in discovered list", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "alpha", context_length: 131072 },
      { id: "beta", context_length: 32768 },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY, ["beta"]);
    const models = await registry.getModels();

    // beta appears only once, and at the front
    expect(models.filter((m) => m === "beta")).toHaveLength(1);
    expect(models[0]).toBe("beta");
  });

  it("returns priorityModels even when API fetch fails", async () => {
    http.enqueueNetworkError("ECONNREFUSED");

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY, ["fallback-model"]);
    const models = await registry.getModels();

    expect(models).toEqual(["fallback-model"]);
  });

  // ── Cycling ────────────────────────────────────────────────────────────────

  it("currentModel() returns first model initially", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "first", context_length: 131072 },
      { id: "second", context_length: 4096 },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();

    expect(registry.currentModel()).toBe("first");
  });

  it("advanceModel() cycles to the next model", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "first", context_length: 131072 },
      { id: "second", context_length: 4096 },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();
    registry.advanceModel();

    expect(registry.currentModel()).toBe("second");
  });

  it("advanceModel() wraps around to first model", async () => {
    http.enqueueJson(makeModelsResponse([
      { id: "first", context_length: 131072 },
      { id: "second", context_length: 4096 },
    ]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();
    registry.advanceModel();
    registry.advanceModel();

    expect(registry.currentModel()).toBe("first");
  });

  it("advanceModel() is a no-op when no models are available", () => {
    http.enqueueNetworkError("ECONNREFUSED");

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    expect(() => registry.advanceModel()).not.toThrow();
    expect(registry.currentModel()).toBeUndefined();
  });

  // ── Cache TTL ──────────────────────────────────────────────────────────────

  it("does not re-fetch within the 1-hour TTL", async () => {
    http.enqueueJson(makeModelsResponse([{ id: "alpha" }]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();
    // Advance 30 minutes — still within TTL
    clock.advance(30 * 60 * 1000);
    await registry.getModels();

    expect(http.getRequests()).toHaveLength(1);
  });

  it("re-fetches after TTL expires", async () => {
    http.enqueueJson(makeModelsResponse([{ id: "alpha" }]));
    http.enqueueJson(makeModelsResponse([{ id: "beta" }]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();
    // Advance past 1 hour
    clock.advance(61 * 60 * 1000);
    const models = await registry.getModels();

    expect(http.getRequests()).toHaveLength(2);
    expect(models).toEqual(["beta"]);
  });

  it("invalidate() forces re-fetch on next use", async () => {
    http.enqueueJson(makeModelsResponse([{ id: "alpha" }]));
    http.enqueueJson(makeModelsResponse([{ id: "beta" }]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();
    registry.invalidate();
    const models = await registry.getModels();

    expect(http.getRequests()).toHaveLength(2);
    expect(models).toContain("beta");
  });

  // ── Auth header ────────────────────────────────────────────────────────────

  it("sends Authorization header with Bearer token", async () => {
    http.enqueueJson(makeModelsResponse([{ id: "alpha" }]));

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();

    const [req] = http.getRequests();
    expect(req.method).toBe("GET");
    expect((req.options as Record<string, unknown>)?.headers).toEqual(
      expect.objectContaining({ Authorization: `Bearer ${FAKE_KEY}` })
    );
  });

  // ── Network errors ─────────────────────────────────────────────────────────

  it("returns empty list when API errors and no priorityModels", async () => {
    http.enqueueNetworkError("fetch failed");

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    const models = await registry.getModels();

    expect(models).toHaveLength(0);
    expect(registry.currentModel()).toBeUndefined();
  });

  it("keeps existing model list when re-fetch fails", async () => {
    http.enqueueJson(makeModelsResponse([{ id: "alpha" }]));
    http.enqueueNetworkError("ECONNREFUSED");

    const registry = new OpenRouterModelRegistry(http, clock, FAKE_KEY);
    await registry.getModels();
    registry.invalidate();
    const models = await registry.getModels();

    expect(models).toEqual(["alpha"]);
  });
});
