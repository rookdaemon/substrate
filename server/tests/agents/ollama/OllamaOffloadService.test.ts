import { OllamaInferenceClient, type IOllamaInferenceClient, type InferenceResult } from "../../../src/agents/ollama/OllamaInferenceClient";
import { OllamaOffloadService, type OffloadTask } from "../../../src/agents/ollama/OllamaOffloadService";
import { InMemoryHttpClient } from "../../../src/agents/ollama/InMemoryHttpClient";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { InMemoryLogger } from "../../../src/logging";

// ── In-memory inference client for offload service tests ──

class MockInferenceClient implements IOllamaInferenceClient {
  private readonly results: InferenceResult[] = [];
  private probeResult = true;

  enqueueSuccess(text: string): void {
    this.results.push({ ok: true, result: text });
  }

  enqueueFailure(reason: "unavailable" | "parse_error" | "timeout"): void {
    this.results.push({ ok: false, reason });
  }

  setProbeResult(ok: boolean): void {
    this.probeResult = ok;
  }

  async infer(): Promise<InferenceResult> {
    const next = this.results.shift();
    if (!next) throw new Error("MockInferenceClient: no more queued results");
    return next;
  }

  async probe(): Promise<boolean> {
    return this.probeResult;
  }
}

// ── Helper: standard compaction quality gate ──

const compactionGate = (result: string) => typeof result === "string" && result.length > 10;

function makeTask(input = "Compact this conversation"): OffloadTask {
  return { taskType: "compaction", input, qualityGate: compactionGate };
}

// ── OllamaInferenceClient tests ──

describe("OllamaInferenceClient", () => {
  let http: InMemoryHttpClient;
  let client: OllamaInferenceClient;
  let logger: InMemoryLogger;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    logger = new InMemoryLogger();
    client = new OllamaInferenceClient(http, "http://localhost:11434", "qwen3:14b", logger);
  });

  it("returns inference result on success", async () => {
    http.enqueueJson({ response: "Compacted summary here" });

    const result = await client.infer("test prompt");
    expect(result).toEqual({ ok: true, result: "Compacted summary here" });

    const requests = http.getRequests();
    expect(requests).toHaveLength(1);
    expect(requests[0].url).toBe("http://localhost:11434/api/generate");
    expect(requests[0].body).toMatchObject({ model: "qwen3:14b", prompt: "test prompt", stream: false });
  });

  it("returns unavailable on non-ok HTTP response", async () => {
    http.enqueueError(503, "Service Unavailable");

    const result = await client.infer("test");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns parse_error when response body is unexpected shape", async () => {
    http.enqueueJson({ unexpected: "shape" });

    const result = await client.infer("test");
    expect(result).toEqual({ ok: false, reason: "parse_error" });
  });

  it("returns unavailable on network error", async () => {
    http.enqueueNetworkError("ECONNREFUSED");

    const result = await client.infer("test");
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("uses custom model when specified", async () => {
    http.enqueueJson({ response: "ok" });

    await client.infer("test", "llama3:8b");
    expect(http.getRequests()[0].body).toMatchObject({ model: "llama3:8b" });
  });

  describe("probe()", () => {
    it("returns true when Ollama is reachable", async () => {
      http.enqueueJson({ models: [] });
      expect(await client.probe()).toBe(true);
    });

    it("returns false on network error", async () => {
      http.enqueueNetworkError("ECONNREFUSED");
      expect(await client.probe()).toBe(false);
    });

    it("returns false on non-ok response", async () => {
      http.enqueueError(500, "Internal Server Error");
      expect(await client.probe()).toBe(false);
    });
  });
});

// ── OllamaOffloadService tests ──

describe("OllamaOffloadService", () => {
  let client: MockInferenceClient;
  let clock: FixedClock;
  let logger: InMemoryLogger;
  let service: OllamaOffloadService;

  beforeEach(() => {
    client = new MockInferenceClient();
    clock = new FixedClock(new Date("2026-03-02T12:00:00Z"));
    logger = new InMemoryLogger();
    service = new OllamaOffloadService(client, clock, logger);
  });

  it("returns successful result when inference and quality gate pass", async () => {
    client.enqueueSuccess("This is a valid compacted summary of the conversation.");

    const result = await service.offload(makeTask());
    expect(result).toEqual({ ok: true, result: "This is a valid compacted summary of the conversation." });
  });

  it("returns unavailable when inference fails", async () => {
    client.enqueueFailure("unavailable");

    const result = await service.offload(makeTask());
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("returns parse_error when inference returns parse_error", async () => {
    client.enqueueFailure("parse_error");

    const result = await service.offload(makeTask());
    expect(result).toEqual({ ok: false, reason: "parse_error" });
  });

  it("returns quality_fail when quality gate rejects output", async () => {
    client.enqueueSuccess("short"); // Fails compactionGate (length <= 10)

    const result = await service.offload(makeTask());
    expect(result).toEqual({ ok: false, reason: "quality_fail" });
  });

  it("tracks consecutive failures", async () => {
    client.enqueueFailure("unavailable");
    client.enqueueFailure("unavailable");

    await service.offload(makeTask());
    await service.offload(makeTask());

    expect(service.getState().consecutiveFailures).toBe(2);
    expect(service.getState().lastStatus).toBe("unavailable");
  });

  it("resets failure count on success", async () => {
    client.enqueueFailure("unavailable");
    client.enqueueFailure("unavailable");
    client.enqueueSuccess("A valid compacted summary that passes the gate.");

    await service.offload(makeTask());
    await service.offload(makeTask());
    await service.offload(makeTask());

    expect(service.getState().consecutiveFailures).toBe(0);
    expect(service.getState().lastStatus).toBe("available");
  });

  describe("backoff behavior", () => {
    it("enters backoff after 3 consecutive failures", async () => {
      client.enqueueFailure("unavailable");
      client.enqueueFailure("unavailable");
      client.enqueueFailure("unavailable");

      await service.offload(makeTask());
      await service.offload(makeTask());
      await service.offload(makeTask());

      expect(service.isInBackoff()).toBe(true);
      expect(service.getState().consecutiveFailures).toBe(3);
    });

    it("skips inference during backoff until interval elapsed", async () => {
      // Drive into backoff
      client.enqueueFailure("unavailable");
      client.enqueueFailure("unavailable");
      client.enqueueFailure("unavailable");
      await service.offload(makeTask());
      await service.offload(makeTask());
      await service.offload(makeTask());

      // Calls 1 and 2 during backoff should be skipped (no inference attempted)
      const r1 = await service.offload(makeTask());
      expect(r1).toEqual({ ok: false, reason: "unavailable" });

      const r2 = await service.offload(makeTask());
      expect(r2).toEqual({ ok: false, reason: "unavailable" });

      // Call 3 should attempt recovery probe + inference
      client.setProbeResult(true);
      client.enqueueSuccess("Recovery successful — valid output for the gate.");

      const r3 = await service.offload(makeTask());
      expect(r3).toEqual({ ok: true, result: "Recovery successful — valid output for the gate." });
      expect(service.isInBackoff()).toBe(false);
    });

    it("stays in backoff if recovery probe fails", async () => {
      // Drive into backoff
      client.enqueueFailure("unavailable");
      client.enqueueFailure("unavailable");
      client.enqueueFailure("unavailable");
      await service.offload(makeTask());
      await service.offload(makeTask());
      await service.offload(makeTask());

      // Skip 2 calls
      await service.offload(makeTask());
      await service.offload(makeTask());

      // Call 3: probe fails
      client.setProbeResult(false);
      const result = await service.offload(makeTask());
      expect(result).toEqual({ ok: false, reason: "unavailable" });
      expect(service.isInBackoff()).toBe(true);
    });
  });

  it("never throws even on unexpected errors", async () => {
    // Use a client that throws unexpectedly
    const brokenClient: IOllamaInferenceClient = {
      infer: async () => { throw new Error("unexpected kaboom"); },
      probe: async () => false,
    };
    const brokenService = new OllamaOffloadService(brokenClient, clock, logger);

    const result = await brokenService.offload(makeTask());
    expect(result).toEqual({ ok: false, reason: "unavailable" });
  });

  it("initial state is unknown with zero failures", () => {
    const state = service.getState();
    expect(state.lastStatus).toBe("unknown");
    expect(state.consecutiveFailures).toBe(0);
    expect(state.callsSinceLastAttempt).toBe(0);
  });

  it("quality gate failure also increments consecutive failures", async () => {
    client.enqueueSuccess("tiny"); // Fails gate

    await service.offload(makeTask());

    expect(service.getState().consecutiveFailures).toBe(1);
  });
});
