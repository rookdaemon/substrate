import { ShellIndependenceService } from "../../src/shell/ShellIndependenceService";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

describe("ShellIndependenceService", () => {
  it("builds a deterministic scorecard from config and static source references", async () => {
    const fs = new InMemoryFileSystem();
    await fs.mkdir("/repo/server/src/loop", { recursive: true });
    await fs.mkdir("/repo/server/src/code-dispatch", { recursive: true });
    await fs.mkdir("/repo/server/src/agents", { recursive: true });
    await fs.writeFile("/repo/server/src/loop/createAgentLayer.ts", "new PiSessionLauncher(); new CodexSessionLauncher(); new OllamaSessionLauncher();");
    await fs.writeFile("/repo/server/src/loop/createLoopLayer.ts", "new CodexCliBackend(); new GeminiCliBackend();");
    await fs.writeFile("/repo/server/src/code-dispatch/CodeDispatcher.ts", "auto dispatch resolves to CodexCliBackend");
    await fs.writeFile("/repo/server/src/agents/ProviderFallbackLauncher.ts", "new GroqSessionLauncher();");
    await fs.writeFile("/repo/server/src/config.ts", "sessionLauncher");
    const clock = new FixedClock(new Date("2026-05-08T00:00:00.000Z"));
    const service = new ShellIndependenceService(fs, clock, {
      sourceCodePath: "/repo",
      sessionLauncher: "pi",
      model: "moonshotai/kimi-k2.6:floor",
      defaultCodeBackend: "auto",
      pi: {
        provider: "openrouter",
        model: "moonshotai/kimi-k2.6:floor",
      },
    });

    const snapshot = await service.refresh();

    expect(snapshot.generatedAt).toBe("2026-05-08T00:00:00.000Z");
    expect(snapshot.inventory.activeCognitiveRoute).toMatchObject({
      provider: "pi",
      kind: "portable-shell",
      model: "moonshotai/kimi-k2.6:floor",
    });
    expect(snapshot.inventory.codeDispatchRoute).toMatchObject({
      provider: "codex",
      kind: "commercial-shell",
    });
    expect(snapshot.inventory.staticShellReferences.map((ref) => ref.symbol)).toEqual(expect.arrayContaining([
      "PiSessionLauncher",
      "CodexSessionLauncher",
      "CodexCliBackend",
      "GeminiCliBackend",
      "OllamaSessionLauncher",
      "GroqSessionLauncher",
    ]));
    expect(snapshot.scorecard.score).toBeLessThan(100);
    expect(snapshot.scorecard.blockers).toContain("default code dispatch depends on commercial shell: codex");
    expect(snapshot.compactReport.join("\n")).toContain("Shell independence score:");
    expect(service.getLastSnapshot()).toBe(snapshot);
  });

  it("scores a local Ollama route higher than commercial shell defaults", async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-05-08T00:00:00.000Z"));
    const service = new ShellIndependenceService(fs, clock, {
      sessionLauncher: "ollama",
      defaultCodeBackend: "gemini",
      ollama: {
        baseUrl: "http://localhost:11434",
        model: "qwen3:14b",
      },
    });

    const snapshot = await service.refresh();

    expect(snapshot.inventory.activeCognitiveRoute.kind).toBe("self-hosted");
    expect(snapshot.scorecard.blockers).toContain("default code dispatch depends on commercial shell: gemini");
    expect(snapshot.scorecard.score).toBeGreaterThanOrEqual(60);
  });
});
