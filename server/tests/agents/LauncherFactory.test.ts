import { createLauncher, LauncherFactoryDeps } from "../../src/agents/LauncherFactory";
import { NodeProcessRunner } from "../../src/agents/claude/NodeProcessRunner";
import { FetchHttpClient } from "../../src/agents/ollama/FetchHttpClient";
import { SystemClock } from "../../src/substrate/abstractions/SystemClock";

const noopLogger = { debug: () => {}, info: () => {}, warn: () => {}, error: () => {} } as any;

describe("LauncherFactory", () => {
  const deps: LauncherFactoryDeps = {
    runner: new NodeProcessRunner(),
    httpClient: new FetchHttpClient(),
    clock: new SystemClock(),
    logger: noopLogger,
  };

  it("throws for claude provider (sdkQuery required)", async () => {
    await expect(createLauncher("claude", deps, "test-model")).rejects.toThrow(
      "sdkQuery dependency"
    );
  });

  it("creates a Pi launcher with PiLauncherArgs", async () => {
    const launcher = await createLauncher("pi", deps, "moonshotai/kimi-k2.6:floor", {
      provider: "openrouter",
      mode: "json",
      thinking: "off",
      apiToken: "test-token",
    });
    expect(launcher).toBeDefined();
    expect(launcher.launch).toBeInstanceOf(Function);
  });

  it("creates an Ollama launcher with OllamaLauncherArgs", async () => {
    const launcher = await createLauncher("ollama", deps, "qwen3:14b", {
      baseUrl: "http://localhost:11434",
      apiKey: undefined,
    });
    expect(launcher).toBeDefined();
    expect(launcher.launch).toBeInstanceOf(Function);
  });

  it("creates a Groq launcher with GroqLauncherArgs", async () => {
    const launcher = await createLauncher("groq", deps, "llama-3.1-8b-instant", {
      apiKey: "test-groq-key",
    });
    expect(launcher).toBeDefined();
  });

  it("creates an Anthropic launcher with AnthropicLauncherArgs", async () => {
    const launcher = await createLauncher("anthropic", deps, "claude-haiku-4-5", {
      accessToken: "sk-ant-test",
    });
    expect(launcher).toBeDefined();
  });

  it("creates a Vertex launcher with VertexLauncherArgs", async () => {
    const launcher = await createLauncher("vertex", deps, "gemini-2.5-flash", {
      apiKey: "test-vertex-key",
    });
    expect(launcher).toBeDefined();
  });

  it("creates a Gemini launcher", async () => {
    const launcher = await createLauncher("gemini", deps, "gemini-2.5-flash-lite");
    expect(launcher).toBeDefined();
  });

  it("creates a Copilot launcher", async () => {
    const launcher = await createLauncher("copilot", deps, undefined);
    expect(launcher).toBeDefined();
  });

  it("creates a Codex launcher", async () => {
    const launcher = await createLauncher("codex", deps, "gpt-5.5");
    expect(launcher).toBeDefined();
  });
});
