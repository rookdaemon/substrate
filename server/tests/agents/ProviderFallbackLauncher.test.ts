import {
  assertApprovedProviderFallback,
  classifyProviderFailure,
  ProviderFallbackLauncher,
  UnsafeProviderFallbackError,
} from "../../src/agents/ProviderFallbackLauncher";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";

describe("ProviderFallbackLauncher", () => {
  it.each([
    ["auth", "Anthropic returned HTTP 401: invalid API key"],
    ["rate_limit", "Codex failed: rate limit exceeded / HTTP 429"],
    ["provider", "Cannot reach Groq API: fetch failed"],
    ["model", "Google AI returned HTTP 404: model not found"],
    ["tool", "mcp tool call failed: no such tool"],
  ] as const)("classifies %s failures", (kind, error) => {
    expect(classifyProviderFailure({
      rawOutput: "",
      exitCode: 1,
      durationMs: 0,
      success: false,
      error,
    })).toEqual(expect.objectContaining({
      kind,
      degradedRouteAllowed: true,
    }));
  });

  it("does not route unknown failures", async () => {
    const primary = new InMemorySessionLauncher();
    const fallback = new InMemorySessionLauncher();
    primary.enqueueFailure("malformed response");
    fallback.enqueueSuccess("fallback");
    const launcher = new ProviderFallbackLauncher(primary, [{
      provider: "ollama",
      model: "qwen3:14b",
      launcher: fallback,
    }]);

    const result = await launcher.launch({ systemPrompt: "", message: "run" });

    expect(result.success).toBe(false);
    expect(fallback.getLaunches()).toHaveLength(0);
  });

  it("routes classified provider failures to an approved degraded route", async () => {
    const primary = new InMemorySessionLauncher();
    const fallback = new InMemorySessionLauncher();
    primary.enqueueFailure("Cannot reach Groq API: fetch failed");
    fallback.enqueueSuccess("fallback ok");
    const launcher = new ProviderFallbackLauncher(primary, [{
      provider: "ollama",
      model: "qwen3:14b",
      launcher: fallback,
    }]);

    const result = await launcher.launch(
      { systemPrompt: "", message: "run" },
      { model: "gpt-5.4-mini", usageContext: { role: "EGO", operation: "decide" } },
    );

    expect(result.success).toBe(true);
    expect(result.rawOutput).toBe("fallback ok");
    expect(fallback.getLaunches()[0].options).toEqual(expect.objectContaining({
      model: "qwen3:14b",
      allowFrontierModel: false,
    }));
  });

  it("blocks unsafe fallback routes to frontier or unknown-cost models", async () => {
    const primary = new InMemorySessionLauncher();
    const unsafe = new InMemorySessionLauncher();
    primary.enqueueFailure("HTTP 429: rate limit exceeded");
    unsafe.enqueueSuccess("unsafe");
    const launcher = new ProviderFallbackLauncher(primary, [{
      provider: "codex",
      model: "gpt-5.5",
      launcher: unsafe,
    }]);

    const result = await launcher.launch({ systemPrompt: "", message: "run" });

    expect(result.success).toBe(false);
    expect(result.error).toContain("no approved degraded provider fallback succeeded");
    expect(unsafe.getLaunches()).toHaveLength(0);
  });

  it("rejects unknown-cost remote fallback models explicitly", () => {
    expect(() => assertApprovedProviderFallback("anthropic", "claude-sonnet-4-20250514"))
      .toThrow(UnsafeProviderFallbackError);
    expect(() => assertApprovedProviderFallback("anthropic", "claude-haiku-4-20250514"))
      .not.toThrow();
  });
});
