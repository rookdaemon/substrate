import { OllamaPreflight } from "../../../src/tools/preflight/OllamaPreflight";
import { InMemoryHttpClient } from "../../../src/agents/ollama/InMemoryHttpClient";
import { TASK_RESULT_SCHEMA } from "../../../src/agents/roles/Subconscious";

const BASE_URL = "http://localhost:11434";
const MODEL = "qwen3:14b";

// ── Helpers ──────────────────────────────────────────────────────────────────

function makeTagsResponse(models: Array<{ name: string }>) {
  return { models };
}

function makeChatResponse(
  content: string,
  extras?: Record<string, unknown>
) {
  return {
    model: MODEL,
    message: { role: "assistant", content },
    done: true,
    ...extras,
  };
}

function makeValidTaskResult() {
  return JSON.stringify({
    result: "success",
    summary: "Completed file read task",
    progressEntry: "Read the file successfully",
    skillUpdates: null,
    memoryUpdates: null,
    proposals: [],
    agoraReplies: [],
  });
}

function makePsResponse(
  models: Array<{ name: string; size?: number; size_vram?: number }>
) {
  return { models };
}

// ── Layer 1: Connectivity ────────────────────────────────────────────────────

describe("OllamaPreflight — Layer 1: Connectivity", () => {
  let http: InMemoryHttpClient;
  let preflight: OllamaPreflight;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    preflight = new OllamaPreflight(http, BASE_URL, MODEL);
  });

  it("1.1 PASS — API reachable when /api/tags returns models array", async () => {
    http.enqueueJson(makeTagsResponse([{ name: MODEL }]));

    const result = await preflight.test11_apiReachable();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("1.1");

    const req = http.getRequests()[0];
    expect(req.method).toBe("GET");
    expect(req.url).toBe(`${BASE_URL}/api/tags`);
  });

  it("1.1 FAIL — connection refused", async () => {
    http.enqueueNetworkError("connect ECONNREFUSED 127.0.0.1:11434");

    const result = await preflight.test11_apiReachable();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("ollama serve");
  });

  it("1.1 FAIL — response missing models array", async () => {
    http.enqueueJson({ notModels: [] });

    const result = await preflight.test11_apiReachable();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("models");
  });

  it("1.2 PASS — target model found in list", async () => {
    http.enqueueJson(
      makeTagsResponse([
        { name: "llama3:8b" },
        { name: MODEL },
      ])
    );

    const result = await preflight.test12_modelAvailable();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("1.2");
  });

  it("1.2 FAIL — model not in list (shows hint)", async () => {
    http.enqueueJson(
      makeTagsResponse([{ name: "llama3:8b" }, { name: "phi4:14b" }])
    );

    const result = await preflight.test12_modelAvailable();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("ollama pull");
    expect(result.detail).toContain(MODEL);
  });

  it("1.3 PASS — model responds to ping", async () => {
    http.enqueueJson(
      makeChatResponse("pong", {
        load_duration: 500_000_000, // 500ms in nanoseconds
        eval_duration: 10_000_000,
        prompt_eval_count: 5,
      })
    );

    const result = await preflight.test13_modelWarm();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("1.3");
    expect(result.detail).toContain("load:");
  });

  it("1.3 detects warm start when load_duration < 1s", async () => {
    http.enqueueJson(
      makeChatResponse("pong", {
        load_duration: 100_000, // 0.1ms — already loaded
        eval_duration: 5_000_000,
      })
    );

    const result = await preflight.test13_modelWarm();

    expect(result.status).toBe("PASS");
    expect(result.detail).toContain("model already loaded");
  });

  it("1.3 FAIL — HTTP error response", async () => {
    http.enqueueError(500, "internal error");

    const result = await preflight.test13_modelWarm();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("500");
  });

  it("Layer 1 fails fast — skips 1.2 and 1.3 when 1.1 fails", async () => {
    http.enqueueNetworkError("connect ECONNREFUSED");

    const report = await preflight.run();

    expect(report.layers).toHaveLength(1);
    expect(report.layers[0].name).toBe("Connectivity");
    expect(report.layers[0].tests).toHaveLength(1);
    expect(report.layers[0].tests[0].id).toBe("1.1");
    expect(report.passed).toBe(false);
  });

  it("Layer 1 fails fast — skips 1.3 when 1.2 fails", async () => {
    // 1.1 passes
    http.enqueueJson(makeTagsResponse([{ name: MODEL }]));
    // 1.2 fails (different model)
    http.enqueueJson(makeTagsResponse([{ name: "llama3:8b" }]));

    const report = await preflight.run();

    expect(report.layers).toHaveLength(1);
    expect(report.layers[0].tests).toHaveLength(2);
    expect(report.layers[0].tests[0].status).toBe("PASS");
    expect(report.layers[0].tests[1].status).toBe("FAIL");
    expect(report.passed).toBe(false);
  });
});

// ── Layer 2: JSON Mode ──────────────────────────────────────────────────────

describe("OllamaPreflight — Layer 2: JSON Mode", () => {
  let http: InMemoryHttpClient;
  let preflight: OllamaPreflight;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    preflight = new OllamaPreflight(http, BASE_URL, MODEL);
  });

  it("2.1 PASS — valid JSON response with format: json", async () => {
    http.enqueueJson(
      makeChatResponse('{"name":"test","value":42}')
    );

    const result = await preflight.test21_basicJson();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("2.1");

    // Verify format: "json" is sent
    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.format).toBe("json");
  });

  it("2.1 FAIL — response is not valid JSON", async () => {
    http.enqueueJson(
      makeChatResponse("Here is your JSON: {invalid}")
    );

    const result = await preflight.test21_basicJson();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("not valid JSON");
  });

  it("2.2 PASS — schema-enforced response with correct fields", async () => {
    http.enqueueJson(
      makeChatResponse('{"result":"success","summary":"Test passed"}')
    );

    const result = await preflight.test22_schemaEnforcement();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("2.2");

    // Verify schema is sent as format
    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.format).toEqual(
      expect.objectContaining({ type: "object" })
    );
  });

  it("2.2 FAIL — result field not in enum", async () => {
    http.enqueueJson(
      makeChatResponse('{"result":"unknown","summary":"Test"}')
    );

    const result = await preflight.test22_schemaEnforcement();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("result");
  });

  it("2.2 FAIL — missing summary field", async () => {
    http.enqueueJson(
      makeChatResponse('{"result":"success","summary":""}')
    );

    const result = await preflight.test22_schemaEnforcement();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("summary");
  });

  it("2.3 PASS — full TaskResult with all required fields", async () => {
    http.enqueueJson(makeChatResponse(makeValidTaskResult()));

    const result = await preflight.test23_fullTaskResult();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("2.3");

    // Verify TASK_RESULT_SCHEMA is sent as format
    const body = http.getRequests()[0].body as Record<string, unknown>;
    expect(body.format).toEqual(TASK_RESULT_SCHEMA);
  });

  it("2.3 FAIL — missing required fields", async () => {
    http.enqueueJson(
      makeChatResponse('{"result":"success","summary":"done"}')
    );

    const result = await preflight.test23_fullTaskResult();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("progressEntry");
  });

  it("2.3 FAIL — proposals is not an array", async () => {
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          result: "success",
          summary: "done",
          progressEntry: "ok",
          skillUpdates: null,
          memoryUpdates: null,
          proposals: "not-an-array",
          agoraReplies: [],
        })
      )
    );

    const result = await preflight.test23_fullTaskResult();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("proposals");
  });

  it("2.3-info — semantic coherence check logged when summary mentions file read", async () => {
    // Need full run for layer 2 to get the INFO check.
    // Set up all layer 1 tests to pass first.
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.1
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.2
    http.enqueueJson(makeChatResponse("pong")); // 1.3
    // Layer 2
    http.enqueueJson(makeChatResponse('{"name":"x","value":1}')); // 2.1
    http.enqueueJson(
      makeChatResponse('{"result":"success","summary":"Test passed"}')
    ); // 2.2
    http.enqueueJson(makeChatResponse(makeValidTaskResult())); // 2.3
    // Layer 3
    http.enqueueJson(makeChatResponse("4")); // 3.1
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "infrastructure" },
            { item: "VRAM", category: "infrastructure" },
            { item: "Nova Daemon", category: "identity" },
            { item: "Empath", category: "identity" },
            { item: "Ollama", category: "infrastructure" },
          ],
        })
      )
    ); // 3.2
    http.enqueueJson(makeChatResponse("Sure, I'll remember 42.")); // 3.3 turn 1
    http.enqueueJson(makeChatResponse("The number was 42.")); // 3.3 turn 2
    // Layer 4
    http.enqueueJson(
      makeChatResponse("A language model...", {
        eval_count: 50,
        eval_duration: 1_000_000_000,
      })
    ); // 4.1
    http.enqueueJson(
      makePsResponse([{ name: MODEL, size_vram: 10 * 1024 * 1024 * 1024 }])
    ); // 4.2

    const report = await preflight.run();

    const layer2 = report.layers.find((l) => l.name === "JSON Mode");
    const infoTest = layer2?.tests.find((t) => t.id === "2.3-info");
    expect(infoTest).toBeDefined();
    expect(infoTest!.status).toBe("INFO");
    // Summary "Completed file read task" mentions "file read"
    expect(infoTest!.detail).toContain("file read");
  });
});

// ── Layer 3: Reasoning Quality ──────────────────────────────────────────────

describe("OllamaPreflight — Layer 3: Reasoning Quality", () => {
  let http: InMemoryHttpClient;
  let preflight: OllamaPreflight;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    preflight = new OllamaPreflight(http, BASE_URL, MODEL);
  });

  it("3.1 PASS — responds with exactly '4'", async () => {
    http.enqueueJson(makeChatResponse("4"));

    const result = await preflight.test31_basicInstruction();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("3.1");
  });

  it("3.1 PASS — trims whitespace before comparing", async () => {
    http.enqueueJson(makeChatResponse("  4  \n"));

    const result = await preflight.test31_basicInstruction();

    expect(result.status).toBe("PASS");
  });

  it("3.1 FAIL — verbose response instead of just '4'", async () => {
    http.enqueueJson(makeChatResponse("The answer is 4"));

    const result = await preflight.test31_basicInstruction();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("4");
  });

  it("3.2 PASS — all 5 items categorized with valid categories", async () => {
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "infrastructure" },
            { item: "VRAM", category: "infrastructure" },
            { item: "Nova Daemon", category: "identity" },
            { item: "Empath", category: "other" },
            { item: "Ollama", category: "infrastructure" },
          ],
        })
      )
    );

    const result = await preflight.test32_categorization();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("3.2");
    // Detail should show the mapping for human review
    expect(result.detail).toContain("RTX 4090");
  });

  it("3.2 PASS — any reasonable category mapping accepted", async () => {
    // All categories are "other" — still valid since we don't enforce
    // expected mappings, only that categories come from the allowed enum
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "other" },
            { item: "VRAM", category: "other" },
            { item: "Nova Daemon", category: "other" },
            { item: "Empath", category: "other" },
            { item: "Ollama", category: "other" },
          ],
        })
      )
    );

    const result = await preflight.test32_categorization();

    expect(result.status).toBe("PASS");
  });

  it("3.2 FAIL — wrong number of items", async () => {
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "infrastructure" },
            { item: "VRAM", category: "infrastructure" },
          ],
        })
      )
    );

    const result = await preflight.test32_categorization();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("Expected 5");
  });

  it("3.2 FAIL — missing item from original list", async () => {
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "infrastructure" },
            { item: "VRAM", category: "infrastructure" },
            { item: "Nova Daemon", category: "identity" },
            { item: "Empath", category: "identity" },
            { item: "GPU", category: "infrastructure" }, // wrong item
          ],
        })
      )
    );

    const result = await preflight.test32_categorization();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("Missing item");
    expect(result.detail).toContain("Ollama");
  });

  it("3.2 FAIL — invalid category value", async () => {
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "hardware" }, // not in enum
            { item: "VRAM", category: "infrastructure" },
            { item: "Nova Daemon", category: "identity" },
            { item: "Empath", category: "identity" },
            { item: "Ollama", category: "infrastructure" },
          ],
        })
      )
    );

    const result = await preflight.test32_categorization();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("Invalid category");
    expect(result.detail).toContain("hardware");
  });

  it("3.2 item matching is case-insensitive", async () => {
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "rtx 4090", category: "infrastructure" },
            { item: "vram", category: "infrastructure" },
            { item: "nova daemon", category: "identity" },
            { item: "empath", category: "identity" },
            { item: "ollama", category: "infrastructure" },
          ],
        })
      )
    );

    const result = await preflight.test32_categorization();

    expect(result.status).toBe("PASS");
  });

  it("3.3 PASS — model retains context across turns", async () => {
    // Turn 1
    http.enqueueJson(
      makeChatResponse("I'll remember the number 42.")
    );
    // Turn 2
    http.enqueueJson(
      makeChatResponse("The number you asked me to remember was 42.")
    );

    const result = await preflight.test33_contextRetention();

    expect(result.status).toBe("PASS");
    expect(result.id).toBe("3.3");
  });

  it("3.3 FAIL — model does not retain the number", async () => {
    http.enqueueJson(makeChatResponse("OK, I'll remember that."));
    http.enqueueJson(
      makeChatResponse("I'm sorry, I don't have memory of previous messages.")
    );

    const result = await preflight.test33_contextRetention();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("42");
  });

  it("3.3 sends conversation history in turn 2", async () => {
    http.enqueueJson(makeChatResponse("Noted: 42"));
    http.enqueueJson(makeChatResponse("42"));

    await preflight.test33_contextRetention();

    const turn2Body = http.getRequests()[1].body as Record<string, unknown>;
    const messages = turn2Body.messages as Array<{
      role: string;
      content: string;
    }>;
    expect(messages).toHaveLength(3);
    expect(messages[0].role).toBe("user");
    expect(messages[0].content).toContain("42");
    expect(messages[1].role).toBe("assistant");
    expect(messages[1].content).toBe("Noted: 42");
    expect(messages[2].role).toBe("user");
    expect(messages[2].content).toContain("number");
  });
});

// ── Layer 4: Performance ─────────────────────────────────────────────────────

describe("OllamaPreflight — Layer 4: Performance", () => {
  let http: InMemoryHttpClient;
  let preflight: OllamaPreflight;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    preflight = new OllamaPreflight(http, BASE_URL, MODEL);
  });

  it("4.1 PASS — throughput > 40 tok/s", async () => {
    http.enqueueJson(
      makeChatResponse("A language model generates text.", {
        eval_count: 50,
        eval_duration: 1_000_000_000, // 1 second → 50 tok/s
      })
    );

    const result = await preflight.test41_throughput();

    expect(result.status).toBe("PASS");
    expect(result.detail).toContain("50.0 tok/s");
  });

  it("4.1 WARN — throughput between 20-40 tok/s", async () => {
    http.enqueueJson(
      makeChatResponse("Text.", {
        eval_count: 30,
        eval_duration: 1_000_000_000, // 30 tok/s
      })
    );

    const result = await preflight.test41_throughput();

    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("30.0 tok/s");
  });

  it("4.1 FAIL — throughput < 20 tok/s (possible CPU mode)", async () => {
    http.enqueueJson(
      makeChatResponse("Text.", {
        eval_count: 10,
        eval_duration: 1_000_000_000, // 10 tok/s
      })
    );

    const result = await preflight.test41_throughput();

    expect(result.status).toBe("FAIL");
    expect(result.detail).toContain("CPU");
  });

  it("4.1 INFO — missing eval metrics", async () => {
    http.enqueueJson(makeChatResponse("Text."));

    const result = await preflight.test41_throughput();

    expect(result.status).toBe("INFO");
    expect(result.detail).toContain("missing");
  });

  it("4.2 PASS — VRAM under 14GB", async () => {
    http.enqueueJson(
      makePsResponse([
        { name: MODEL, size_vram: 10 * 1024 * 1024 * 1024 }, // 10GB
      ])
    );

    const result = await preflight.test42_vram();

    expect(result.status).toBe("PASS");
    expect(result.detail).toContain("10.0GB");
  });

  it("4.2 WARN — VRAM over 14GB", async () => {
    http.enqueueJson(
      makePsResponse([
        { name: MODEL, size_vram: 15 * 1024 * 1024 * 1024 }, // 15GB
      ])
    );

    const result = await preflight.test42_vram();

    expect(result.status).toBe("WARN");
    expect(result.detail).toContain("15.0GB");
  });

  it("4.2 INFO — model not in running list", async () => {
    http.enqueueJson(makePsResponse([{ name: "llama3:8b" }]));

    const result = await preflight.test42_vram();

    expect(result.status).toBe("INFO");
    expect(result.detail).toContain("not in running");
  });

  it("4.2 INFO — /api/ps endpoint not available", async () => {
    http.enqueueError(404, "not found");

    const result = await preflight.test42_vram();

    expect(result.status).toBe("INFO");
  });
});

// ── Full run integration ─────────────────────────────────────────────────────

describe("OllamaPreflight — full run", () => {
  let http: InMemoryHttpClient;
  let preflight: OllamaPreflight;

  beforeEach(() => {
    http = new InMemoryHttpClient();
    preflight = new OllamaPreflight(http, BASE_URL, MODEL);
  });

  it("all layers pass — report shows READY", async () => {
    // Layer 1
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.1
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.2
    http.enqueueJson(makeChatResponse("pong")); // 1.3
    // Layer 2
    http.enqueueJson(makeChatResponse('{"name":"x","value":1}')); // 2.1
    http.enqueueJson(
      makeChatResponse('{"result":"success","summary":"Test passed"}')
    ); // 2.2
    http.enqueueJson(makeChatResponse(makeValidTaskResult())); // 2.3
    // Layer 3
    http.enqueueJson(makeChatResponse("4")); // 3.1
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "infrastructure" },
            { item: "VRAM", category: "infrastructure" },
            { item: "Nova Daemon", category: "identity" },
            { item: "Empath", category: "identity" },
            { item: "Ollama", category: "infrastructure" },
          ],
        })
      )
    ); // 3.2
    http.enqueueJson(makeChatResponse("Remembering 42.")); // 3.3 turn 1
    http.enqueueJson(makeChatResponse("You said 42.")); // 3.3 turn 2
    // Layer 4
    http.enqueueJson(
      makeChatResponse("LM explanation", {
        eval_count: 50,
        eval_duration: 1_000_000_000,
      })
    ); // 4.1
    http.enqueueJson(
      makePsResponse([{ name: MODEL, size_vram: 10 * 1024 * 1024 * 1024 }])
    ); // 4.2

    const report = await preflight.run();

    expect(report.passed).toBe(true);
    expect(report.failCount).toBe(0);
    expect(report.layers).toHaveLength(4);
    expect(report.target).toBe(BASE_URL);
    expect(report.model).toBe(MODEL);

    const formatted = OllamaPreflight.formatReport(report);
    expect(formatted).toContain("READY FOR SELF-HOSTED CYCLE");
  });

  it("Layer 1 failure aborts all subsequent layers", async () => {
    http.enqueueNetworkError("connect ECONNREFUSED");

    const report = await preflight.run();

    expect(report.passed).toBe(false);
    expect(report.layers).toHaveLength(1);
    expect(report.failCount).toBe(1);

    const formatted = OllamaPreflight.formatReport(report);
    expect(formatted).toContain("NOT READY");
  });

  it("Layer 2+ failure does not abort other layers", async () => {
    // Layer 1 passes
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.1
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.2
    http.enqueueJson(makeChatResponse("pong")); // 1.3
    // Layer 2 — test 2.1 fails (non-JSON)
    http.enqueueJson(makeChatResponse("not json {{{")); // 2.1 fail
    http.enqueueJson(
      makeChatResponse('{"result":"success","summary":"ok"}')
    ); // 2.2
    http.enqueueJson(makeChatResponse(makeValidTaskResult())); // 2.3
    // Layer 3 still runs
    http.enqueueJson(makeChatResponse("4")); // 3.1
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "infrastructure" },
            { item: "VRAM", category: "infrastructure" },
            { item: "Nova Daemon", category: "identity" },
            { item: "Empath", category: "identity" },
            { item: "Ollama", category: "infrastructure" },
          ],
        })
      )
    ); // 3.2
    http.enqueueJson(makeChatResponse("Noted 42.")); // 3.3 turn 1
    http.enqueueJson(makeChatResponse("42")); // 3.3 turn 2
    // Layer 4 still runs
    http.enqueueJson(
      makeChatResponse("LM", {
        eval_count: 50,
        eval_duration: 1_000_000_000,
      })
    ); // 4.1
    http.enqueueJson(
      makePsResponse([{ name: MODEL, size_vram: 10 * 1024 * 1024 * 1024 }])
    ); // 4.2

    const report = await preflight.run();

    expect(report.passed).toBe(false);
    expect(report.failCount).toBe(1);
    // All 4 layers ran
    expect(report.layers).toHaveLength(4);
  });

  it("report format includes warnings count", async () => {
    // Set up full pass except 4.1 warns
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.1
    http.enqueueJson(makeTagsResponse([{ name: MODEL }])); // 1.2
    http.enqueueJson(makeChatResponse("pong")); // 1.3
    http.enqueueJson(makeChatResponse('{"name":"x","value":1}')); // 2.1
    http.enqueueJson(
      makeChatResponse('{"result":"success","summary":"ok"}')
    ); // 2.2
    http.enqueueJson(makeChatResponse(makeValidTaskResult())); // 2.3
    http.enqueueJson(makeChatResponse("4")); // 3.1
    http.enqueueJson(
      makeChatResponse(
        JSON.stringify({
          categories: [
            { item: "RTX 4090", category: "infrastructure" },
            { item: "VRAM", category: "infrastructure" },
            { item: "Nova Daemon", category: "identity" },
            { item: "Empath", category: "identity" },
            { item: "Ollama", category: "infrastructure" },
          ],
        })
      )
    ); // 3.2
    http.enqueueJson(makeChatResponse("42 noted.")); // 3.3 turn 1
    http.enqueueJson(makeChatResponse("42")); // 3.3 turn 2
    http.enqueueJson(
      makeChatResponse("LM", {
        eval_count: 25,
        eval_duration: 1_000_000_000, // 25 tok/s → WARN
      })
    ); // 4.1
    http.enqueueJson(
      makePsResponse([{ name: MODEL, size_vram: 10 * 1024 * 1024 * 1024 }])
    ); // 4.2

    const report = await preflight.run();

    expect(report.passed).toBe(true);
    expect(report.warnCount).toBe(1);

    const formatted = OllamaPreflight.formatReport(report);
    expect(formatted).toContain("1 warning(s)");
    expect(formatted).toContain("READY");
  });
});
