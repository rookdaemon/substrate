import type { IHttpClient } from "../../agents/ollama/IHttpClient";
import { TASK_RESULT_SCHEMA } from "../../agents/roles/Subconscious";

/**
 * Standalone Ollama preflight verification tool.
 * Validates connectivity, JSON mode, reasoning quality, and performance
 * before switching the agent loop to self-hosted inference.
 *
 * Four-layer fail-fast design:
 *   Layer 1 — Connectivity: Is Ollama reachable? Is the model available?
 *   Layer 2 — JSON Mode: Does grammar-constrained decoding work?
 *   Layer 3 — Reasoning Quality: Can the model follow instructions?
 *   Layer 4 — Performance: Is throughput acceptable?
 *
 * Spec: Nova Daemon (memory/ollama_preflight_test_spec.md)
 * Implementation: Rook Daemon
 */

// ── Types ────────────────────────────────────────────────────────────────────

export type TestStatus = "PASS" | "FAIL" | "WARN" | "INFO";

export interface PreflightTestResult {
  id: string;
  name: string;
  status: TestStatus;
  detail?: string;
  durationMs: number;
}

export interface PreflightLayer {
  name: string;
  tests: PreflightTestResult[];
}

export interface PreflightReport {
  target: string;
  model: string;
  timestamp: string;
  layers: PreflightLayer[];
  passed: boolean;
  failCount: number;
  warnCount: number;
}

// ── Schemas used in tests ────────────────────────────────────────────────────

/** Schema for test 2.2 — minimal result + summary object */
const SIMPLE_RESULT_SCHEMA = {
  type: "object",
  properties: {
    result: { type: "string", enum: ["success", "failure", "partial"] },
    summary: { type: "string" },
  },
  required: ["result", "summary"],
} as const;

/** Schema for test 3.2 — categorization probe */
const CATEGORIZATION_SCHEMA = {
  type: "object",
  properties: {
    categories: {
      type: "array",
      items: {
        type: "object",
        properties: {
          item: { type: "string" },
          category: {
            type: "string",
            enum: ["infrastructure", "identity", "other"],
          },
        },
        required: ["item", "category"],
      },
    },
  },
  required: ["categories"],
} as const;

/** The 5 items for test 3.2 */
const CATEGORIZATION_ITEMS = [
  "RTX 4090",
  "VRAM",
  "Nova Daemon",
  "Empath",
  "Ollama",
];

// ── Timeouts ─────────────────────────────────────────────────────────────────

const CONNECTIVITY_TIMEOUT_MS = 5_000;
const WARM_MODEL_TIMEOUT_MS = 90_000; // 60s spec + 30s margin for cold start
const INFERENCE_TIMEOUT_MS = 60_000;

// ── Performance thresholds ───────────────────────────────────────────────────

const MIN_THROUGHPUT_TOKS = 20;
const GOOD_THROUGHPUT_TOKS = 40;
const VRAM_WARN_GB = 14;

// ── Implementation ───────────────────────────────────────────────────────────

export class OllamaPreflight {
  constructor(
    private readonly httpClient: IHttpClient,
    private readonly baseUrl: string,
    private readonly model: string
  ) {}

  /**
   * Run the full preflight suite.
   * Layer 1 failures are fatal — later layers are skipped.
   * Layers 2-4 run in sequence regardless of individual test failures.
   */
  async run(): Promise<PreflightReport> {
    const timestamp = new Date().toISOString();
    const layers: PreflightLayer[] = [];
    let abortAfterLayer1 = false;

    // Layer 1: Connectivity (fail-fast)
    const layer1 = await this.runLayer1();
    layers.push(layer1);
    if (layer1.tests.some((t) => t.status === "FAIL")) {
      abortAfterLayer1 = true;
    }

    if (!abortAfterLayer1) {
      // Layer 2: JSON Mode
      const layer2 = await this.runLayer2();
      layers.push(layer2);

      // Layer 3: Reasoning Quality
      const layer3 = await this.runLayer3();
      layers.push(layer3);

      // Layer 4: Performance
      const layer4 = await this.runLayer4();
      layers.push(layer4);
    }

    const allTests = layers.flatMap((l) => l.tests);
    const failCount = allTests.filter((t) => t.status === "FAIL").length;
    const warnCount = allTests.filter((t) => t.status === "WARN").length;

    return {
      target: this.baseUrl,
      model: this.model,
      timestamp,
      layers,
      passed: failCount === 0,
      failCount,
      warnCount,
    };
  }

  // ── Layer 1: Connectivity ────────────────────────────────────────────────

  private async runLayer1(): Promise<PreflightLayer> {
    const tests: PreflightTestResult[] = [];

    // Test 1.1 — Ollama API is reachable
    const test11 = await this.test11_apiReachable();
    tests.push(test11);
    if (test11.status === "FAIL") {
      return { name: "Connectivity", tests };
    }

    // Test 1.2 — Target model is available
    const test12 = await this.test12_modelAvailable();
    tests.push(test12);
    if (test12.status === "FAIL") {
      return { name: "Connectivity", tests };
    }

    // Test 1.3 — Model is loaded (warm)
    const test13 = await this.test13_modelWarm();
    tests.push(test13);

    return { name: "Connectivity", tests };
  }

  async test11_apiReachable(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.get(`${this.baseUrl}/api/tags`, {
        timeoutMs: CONNECTIVITY_TIMEOUT_MS,
      });
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "1.1",
          name: "Ollama API reachable",
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as { models?: unknown[] };
      if (!Array.isArray(data.models)) {
        return {
          id: "1.1",
          name: "Ollama API reachable",
          status: "FAIL",
          detail: "Response missing 'models' array",
          durationMs: elapsed,
        };
      }

      return {
        id: "1.1",
        name: "Ollama API reachable",
        status: "PASS",
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "1.1",
        name: "Ollama API reachable",
        status: "FAIL",
        detail: `Ollama is not running at ${this.baseUrl}. Start it with: ollama serve (${err instanceof Error ? err.message : String(err)})`,
        durationMs: Date.now() - start,
      };
    }
  }

  async test12_modelAvailable(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.get(`${this.baseUrl}/api/tags`, {
        timeoutMs: CONNECTIVITY_TIMEOUT_MS,
      });
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "1.2",
          name: `Model ${this.model} available`,
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        models?: Array<{ name?: string }>;
      };
      const models = data.models ?? [];
      const found = models.some(
        (m) => m.name === this.model || m.name?.startsWith(`${this.model}-`)
      );

      if (!found) {
        const available = models.map((m) => m.name).join(", ");
        return {
          id: "1.2",
          name: `Model ${this.model} available`,
          status: "FAIL",
          detail: `Model not found. Pull it with: ollama pull ${this.model}. Available: ${available || "none"}`,
          durationMs: elapsed,
        };
      }

      return {
        id: "1.2",
        name: `Model ${this.model} available`,
        status: "PASS",
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "1.2",
        name: `Model ${this.model} available`,
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async test13_modelWarm(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [{ role: "user", content: "ping" }],
          stream: false,
        },
        { timeoutMs: WARM_MODEL_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response.ok) {
        const body = await response.text();
        return {
          id: "1.3",
          name: "Model loaded (warm)",
          status: "FAIL",
          detail: `HTTP ${response.status}: ${body}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
        eval_duration?: number;
        prompt_eval_count?: number;
        load_duration?: number;
      };

      if (!data.message?.content) {
        return {
          id: "1.3",
          name: "Model loaded (warm)",
          status: "FAIL",
          detail: "Response missing message.content",
          durationMs: elapsed,
        };
      }

      // Detect cold vs warm start
      const loadDurationMs = data.load_duration
        ? data.load_duration / 1e6 // Ollama returns nanoseconds
        : undefined;
      const isWarmStart = loadDurationMs !== undefined && loadDurationMs < 1000;

      let detail = `${elapsed}ms total`;
      if (loadDurationMs !== undefined) {
        detail += `, load: ${loadDurationMs.toFixed(0)}ms`;
      }
      if (data.eval_duration) {
        detail += `, eval: ${(data.eval_duration / 1e6).toFixed(0)}ms`;
      }
      if (data.prompt_eval_count !== undefined) {
        detail += `, prompt_tokens: ${data.prompt_eval_count}`;
      }
      if (isWarmStart) {
        detail += " (model already loaded)";
      }

      return {
        id: "1.3",
        name: "Model loaded (warm)",
        status: "PASS",
        detail,
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "1.3",
        name: "Model loaded (warm)",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Layer 2: JSON Mode ───────────────────────────────────────────────────

  private async runLayer2(): Promise<PreflightLayer> {
    const tests: PreflightTestResult[] = [];

    tests.push(await this.test21_basicJson());
    tests.push(await this.test22_schemaEnforcement());
    const test23Result = await this.test23_fullTaskResult();
    tests.push(test23Result);

    // INFO check: does the TaskResult summary mention "file read"?
    if (test23Result.status === "PASS" && test23Result._parsedSummary) {
      const summary = (test23Result._parsedSummary as string).toLowerCase();
      const mentionsFileRead =
        summary.includes("file read") || summary.includes("read");
      tests.push({
        id: "2.3-info",
        name: "Semantic coherence check",
        status: "INFO",
        detail: mentionsFileRead
          ? "Summary references 'file read' — good semantic coherence"
          : "Summary does not mention 'file read' — may indicate generic filler",
        durationMs: 0,
      });
    }

    return { name: "JSON Mode", tests };
  }

  async test21_basicJson(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            {
              role: "user",
              content:
                'Return a JSON object with keys: name (string), value (number)',
            },
          ],
          stream: false,
          format: "json",
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "2.1",
          name: "Basic JSON format enforcement",
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const content = data.message?.content ?? "";

      try {
        JSON.parse(content);
      } catch {
        return {
          id: "2.1",
          name: "Basic JSON format enforcement",
          status: "FAIL",
          detail: `Response is not valid JSON: ${content.slice(0, 100)}`,
          durationMs: elapsed,
        };
      }

      return {
        id: "2.1",
        name: "Basic JSON format enforcement",
        status: "PASS",
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "2.1",
        name: "Basic JSON format enforcement",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async test22_schemaEnforcement(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            {
              role: "user",
              content:
                "Return a task result indicating success with summary 'Test passed'",
            },
          ],
          stream: false,
          format: SIMPLE_RESULT_SCHEMA,
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "2.2",
          name: "JSON schema enforcement",
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const content = data.message?.content ?? "";

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        return {
          id: "2.2",
          name: "JSON schema enforcement",
          status: "FAIL",
          detail: `Response is not valid JSON: ${content.slice(0, 100)}`,
          durationMs: elapsed,
        };
      }

      const validResults = ["success", "failure", "partial"];
      if (!validResults.includes(parsed.result as string)) {
        return {
          id: "2.2",
          name: "JSON schema enforcement",
          status: "FAIL",
          detail: `'result' field is '${parsed.result}', expected one of: ${validResults.join(", ")}`,
          durationMs: elapsed,
        };
      }

      if (typeof parsed.summary !== "string" || parsed.summary.length === 0) {
        return {
          id: "2.2",
          name: "JSON schema enforcement",
          status: "FAIL",
          detail: "Missing or empty 'summary' field",
          durationMs: elapsed,
        };
      }

      return {
        id: "2.2",
        name: "JSON schema enforcement",
        status: "PASS",
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "2.2",
        name: "JSON schema enforcement",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async test23_fullTaskResult(): Promise<PreflightTestResult & { _parsedSummary?: string }> {
    const start = Date.now();
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            {
              role: "user",
              content:
                "You just completed a simple file read task successfully. Return a TaskResult JSON.",
            },
          ],
          stream: false,
          format: TASK_RESULT_SCHEMA,
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "2.3",
          name: "Full TaskResult schema",
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const content = data.message?.content ?? "";

      let parsed: Record<string, unknown>;
      try {
        parsed = JSON.parse(content) as Record<string, unknown>;
      } catch {
        return {
          id: "2.3",
          name: "Full TaskResult schema",
          status: "FAIL",
          detail: `Response is not valid JSON: ${content.slice(0, 100)}`,
          durationMs: elapsed,
        };
      }

      // Validate required fields
      const issues: string[] = [];

      const validResults = ["success", "failure", "partial"];
      if (!validResults.includes(parsed.result as string)) {
        issues.push(`result: '${parsed.result}' not in enum`);
      }
      if (typeof parsed.summary !== "string") {
        issues.push("summary: not a string");
      }
      if (typeof parsed.progressEntry !== "string") {
        issues.push("progressEntry: not a string");
      }
      if (
        parsed.skillUpdates !== null &&
        typeof parsed.skillUpdates !== "string"
      ) {
        issues.push("skillUpdates: not string|null");
      }
      if (
        parsed.memoryUpdates !== null &&
        typeof parsed.memoryUpdates !== "string"
      ) {
        issues.push("memoryUpdates: not string|null");
      }
      if (!Array.isArray(parsed.proposals)) {
        issues.push("proposals: not an array");
      }
      if (!Array.isArray(parsed.agoraReplies)) {
        issues.push("agoraReplies: not an array");
      }

      if (issues.length > 0) {
        return {
          id: "2.3",
          name: "Full TaskResult schema",
          status: "FAIL",
          detail: `Schema violations: ${issues.join("; ")}`,
          durationMs: elapsed,
        };
      }

      return {
        id: "2.3",
        name: "Full TaskResult schema",
        status: "PASS",
        durationMs: elapsed,
        _parsedSummary: parsed.summary as string,
      };
    } catch (err) {
      return {
        id: "2.3",
        name: "Full TaskResult schema",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Layer 3: Reasoning Quality ───────────────────────────────────────────

  private async runLayer3(): Promise<PreflightLayer> {
    const tests: PreflightTestResult[] = [];

    tests.push(await this.test31_basicInstruction());
    tests.push(await this.test32_categorization());
    tests.push(await this.test33_contextRetention());

    return { name: "Reasoning Quality", tests };
  }

  async test31_basicInstruction(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            {
              role: "user",
              content:
                "What is 2 + 2? Respond with only the number, no explanation.",
            },
          ],
          stream: false,
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "3.1",
          name: "Basic instruction following",
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const content = (data.message?.content ?? "").trim();

      if (content === "4") {
        return {
          id: "3.1",
          name: "Basic instruction following",
          status: "PASS",
          durationMs: elapsed,
        };
      }

      return {
        id: "3.1",
        name: "Basic instruction following",
        status: "FAIL",
        detail: `Expected exactly "4", got: "${content.slice(0, 50)}"`,
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "3.1",
        name: "Basic instruction following",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async test32_categorization(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            {
              role: "system",
              content:
                "You are a classifier. Categorize each item as exactly one of: infrastructure, identity, or other.",
            },
            {
              role: "user",
              content: `Categorize these 5 items: [${CATEGORIZATION_ITEMS.join(", ")}]`,
            },
          ],
          stream: false,
          format: CATEGORIZATION_SCHEMA,
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "3.2",
          name: "Comprehension + instruction-following + JSON compliance",
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        message?: { content?: string };
      };
      const content = data.message?.content ?? "";

      let parsed: { categories?: Array<{ item?: string; category?: string }> };
      try {
        parsed = JSON.parse(content) as typeof parsed;
      } catch {
        return {
          id: "3.2",
          name: "Comprehension + instruction-following + JSON compliance",
          status: "FAIL",
          detail: `Not valid JSON: ${content.slice(0, 100)}`,
          durationMs: elapsed,
        };
      }

      const issues: string[] = [];
      const categories = parsed.categories;

      // Condition 1: schema-valid (categories is array)
      if (!Array.isArray(categories)) {
        return {
          id: "3.2",
          name: "Comprehension + instruction-following + JSON compliance",
          status: "FAIL",
          detail: "'categories' is not an array",
          durationMs: elapsed,
        };
      }

      // Condition 2: exactly 5 items
      if (categories.length !== 5) {
        issues.push(`Expected 5 items, got ${categories.length}`);
      }

      // Condition 3: all 5 original items present (case-insensitive)
      const responseItems = categories.map((c) =>
        (c.item ?? "").toLowerCase()
      );
      const validCategories = ["infrastructure", "identity", "other"];

      for (const expected of CATEGORIZATION_ITEMS) {
        if (!responseItems.includes(expected.toLowerCase())) {
          issues.push(`Missing item: "${expected}"`);
        }
      }

      // Condition 4: all categories from allowed enum
      for (const entry of categories) {
        if (!validCategories.includes(entry.category ?? "")) {
          issues.push(
            `Invalid category "${entry.category}" for item "${entry.item}"`
          );
        }
      }

      if (issues.length > 0) {
        return {
          id: "3.2",
          name: "Comprehension + instruction-following + JSON compliance",
          status: "FAIL",
          detail: issues.join("; "),
          durationMs: elapsed,
        };
      }

      // Log the actual categorizations for human review
      const mapping = categories
        .map((c) => `${c.item} → ${c.category}`)
        .join(", ");

      return {
        id: "3.2",
        name: "Comprehension + instruction-following + JSON compliance",
        status: "PASS",
        detail: mapping,
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "3.2",
        name: "Comprehension + instruction-following + JSON compliance",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async test33_contextRetention(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      // Turn 1: ask the model to remember a number
      const response1 = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            { role: "user", content: "Remember the number 42." },
          ],
          stream: false,
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );

      if (!response1.ok) {
        return {
          id: "3.3",
          name: "Context retention",
          status: "FAIL",
          detail: `Turn 1 HTTP ${response1.status}`,
          durationMs: Date.now() - start,
        };
      }

      const data1 = (await response1.json()) as {
        message?: { content?: string };
      };
      const assistant1 = data1.message?.content ?? "";

      // Turn 2: ask what number — with full conversation history
      const response2 = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            { role: "user", content: "Remember the number 42." },
            { role: "assistant", content: assistant1 },
            {
              role: "user",
              content: "What number did I ask you to remember?",
            },
          ],
          stream: false,
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response2.ok) {
        return {
          id: "3.3",
          name: "Context retention",
          status: "FAIL",
          detail: `Turn 2 HTTP ${response2.status}`,
          durationMs: elapsed,
        };
      }

      const data2 = (await response2.json()) as {
        message?: { content?: string };
      };
      const content2 = data2.message?.content ?? "";

      if (content2.includes("42")) {
        return {
          id: "3.3",
          name: "Context retention",
          status: "PASS",
          detail: `Response: "${content2.slice(0, 80)}"`,
          durationMs: elapsed,
        };
      }

      return {
        id: "3.3",
        name: "Context retention",
        status: "FAIL",
        detail: `Response does not contain "42": "${content2.slice(0, 80)}"`,
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "3.3",
        name: "Context retention",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Layer 4: Performance ─────────────────────────────────────────────────

  private async runLayer4(): Promise<PreflightLayer> {
    const tests: PreflightTestResult[] = [];

    tests.push(await this.test41_throughput());
    tests.push(await this.test42_vram());

    return { name: "Performance", tests };
  }

  async test41_throughput(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.post(
        `${this.baseUrl}/api/chat`,
        {
          model: this.model,
          messages: [
            {
              role: "user",
              content:
                "Explain in 2-3 sentences what a language model is and how it generates text. Be concise.",
            },
          ],
          stream: false,
        },
        { timeoutMs: INFERENCE_TIMEOUT_MS }
      );
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "4.1",
          name: "Token throughput",
          status: "FAIL",
          detail: `HTTP ${response.status}`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        eval_count?: number;
        eval_duration?: number;
      };

      if (!data.eval_count || !data.eval_duration) {
        return {
          id: "4.1",
          name: "Token throughput",
          status: "INFO",
          detail:
            "Ollama response missing eval_count/eval_duration — cannot measure throughput",
          durationMs: elapsed,
        };
      }

      // eval_duration is in nanoseconds
      const tokPerSec =
        data.eval_count / (data.eval_duration / 1e9);
      const detail = `${tokPerSec.toFixed(1)} tok/s (${data.eval_count} tokens)`;

      if (tokPerSec < MIN_THROUGHPUT_TOKS) {
        return {
          id: "4.1",
          name: "Token throughput",
          status: "FAIL",
          detail: `${detail} — below ${MIN_THROUGHPUT_TOKS} tok/s minimum (may be running on CPU)`,
          durationMs: elapsed,
        };
      }

      if (tokPerSec < GOOD_THROUGHPUT_TOKS) {
        return {
          id: "4.1",
          name: "Token throughput",
          status: "WARN",
          detail: `${detail} — acceptable but below ${GOOD_THROUGHPUT_TOKS} tok/s target`,
          durationMs: elapsed,
        };
      }

      return {
        id: "4.1",
        name: "Token throughput",
        status: "PASS",
        detail,
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "4.1",
        name: "Token throughput",
        status: "FAIL",
        detail: err instanceof Error ? err.message : String(err),
        durationMs: Date.now() - start,
      };
    }
  }

  async test42_vram(): Promise<PreflightTestResult> {
    const start = Date.now();
    try {
      const response = await this.httpClient.get(`${this.baseUrl}/api/ps`, {
        timeoutMs: CONNECTIVITY_TIMEOUT_MS,
      });
      const elapsed = Date.now() - start;

      if (!response.ok) {
        return {
          id: "4.2",
          name: "VRAM usage",
          status: "INFO",
          detail: `HTTP ${response.status} — cannot check VRAM usage`,
          durationMs: elapsed,
        };
      }

      const data = (await response.json()) as {
        models?: Array<{
          name?: string;
          size?: number;
          size_vram?: number;
        }>;
      };

      const models = data.models ?? [];
      const target = models.find(
        (m) =>
          m.name === this.model || m.name?.startsWith(`${this.model}-`)
      );

      if (!target) {
        return {
          id: "4.2",
          name: "VRAM usage",
          status: "INFO",
          detail: `Model ${this.model} not in running model list`,
          durationMs: elapsed,
        };
      }

      const vramBytes = target.size_vram ?? target.size ?? 0;
      const vramGB = vramBytes / (1024 * 1024 * 1024);
      const detail = `${vramGB.toFixed(1)}GB`;

      if (vramGB > VRAM_WARN_GB) {
        return {
          id: "4.2",
          name: "VRAM usage",
          status: "WARN",
          detail: `${detail} — approaching 16GB limit`,
          durationMs: elapsed,
        };
      }

      return {
        id: "4.2",
        name: "VRAM usage",
        status: "PASS",
        detail,
        durationMs: elapsed,
      };
    } catch (err) {
      return {
        id: "4.2",
        name: "VRAM usage",
        status: "INFO",
        detail: `Cannot check VRAM: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - start,
      };
    }
  }

  // ── Report formatting ──────────────────────────────────────────────────

  static formatReport(report: PreflightReport): string {
    const lines: string[] = [];
    lines.push("=== Ollama Preflight Report ===");
    lines.push(`Target: ${report.target}`);
    lines.push(`Model: ${report.model}`);
    lines.push(`Timestamp: ${report.timestamp}`);
    lines.push("");

    for (const layer of report.layers) {
      lines.push(`Layer ${report.layers.indexOf(layer) + 1}: ${layer.name}`);
      for (const test of layer.tests) {
        const duration =
          test.durationMs > 0 ? ` (${test.durationMs}ms)` : "";
        const detail = test.detail ? ` \u2014 ${test.detail}` : "";
        lines.push(
          `  [${test.status}] ${test.id} ${test.name}${detail}${duration}`
        );
      }
      lines.push("");
    }

    if (report.passed) {
      lines.push("=== RESULT: READY FOR SELF-HOSTED CYCLE ===");
    } else {
      lines.push(
        `=== RESULT: NOT READY \u2014 ${report.failCount} test(s) failed ===`
      );
      const failures = report.layers
        .flatMap((l) => l.tests)
        .filter((t) => t.status === "FAIL");
      for (const f of failures) {
        lines.push(`FAIL ${f.id} \u2014 ${f.detail ?? f.name}`);
      }
    }

    if (report.warnCount > 0) {
      lines.push(`(${report.warnCount} warning(s))`);
    }

    return lines.join("\n");
  }
}
