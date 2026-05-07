import { createApplication, ApplicationConfig, Application } from "../../src/loop/createApplication";
import { LoopState } from "../../src/loop/types";
import type { SdkQueryFn } from "../../src/agents/claude/AgentSdkLauncher";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { InMemoryLogger } from "../../src/logging";

const mockSdkQuery: SdkQueryFn = async function* () {
  yield { type: "unused" };
};

describe("createApplication", () => {
  const createdApps: Application[] = [];

  afterEach(async () => {
    for (const app of createdApps) {
      try {
        await app.stop();
      } catch {
        // ignore
      }
    }
    createdApps.length = 0;
  });

  function baseConfig(overrides?: Partial<ApplicationConfig>): ApplicationConfig {
    return {
      substratePath: "/substrate",
      sdkQueryFn: mockSdkQuery,
      env: {
        fs: new InMemoryFileSystem(),
        logger: new InMemoryLogger(),
      },
      ...overrides,
    };
  }

  it("creates an application with all components wired", async () => {
    const app = await createApplication(baseConfig({
      cycleDelayMs: 1000,
      superegoAuditInterval: 10,
      maxConsecutiveIdleCycles: 5,
    }));
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator).toBeDefined();
    expect(app.httpServer).toBeDefined();
    expect(app.wsServer).toBeDefined();
  });

  it("orchestrator starts in STOPPED state", async () => {
    const app = await createApplication(baseConfig({
      cycleDelayMs: 500,
      superegoAuditInterval: 5,
      maxConsecutiveIdleCycles: 3,
    }));
    createdApps.push(app);

    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("provides start and stop methods", async () => {
    const app = await createApplication(baseConfig({
      cycleDelayMs: 1000,
      superegoAuditInterval: 10,
      maxConsecutiveIdleCycles: 5,
    }));
    createdApps.push(app);

    expect(typeof app.start).toBe("function");
    expect(typeof app.stop).toBe("function");
  });

  it("uses default config for optional fields", async () => {
    const app = await createApplication(baseConfig());
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("creates application successfully with watchdog disabled", async () => {
    const app = await createApplication(baseConfig({
      watchdog: { disabled: true },
    }));
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("creates application successfully with custom watchdog timing", async () => {
    const app = await createApplication(baseConfig({
      watchdog: { stallThresholdMs: 5 * 60 * 1000, checkIntervalMs: 60 * 1000 },
    }));
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("creates application with sessionLauncher: 'codex'", async () => {
    const app = await createApplication(baseConfig({
      sessionLauncher: "codex",
    }));
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("creates application with sessionLauncher: 'pi'", async () => {
    const app = await createApplication(baseConfig({
      sessionLauncher: "pi",
      pi: { provider: "openai", model: "gpt-5.5", mode: "json" },
    }));
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  describe("sleep-preservation: forceStart when sleeping", () => {
    it("forceStart=true does not wake loop when initialized in SLEEPING state", async () => {
      const app = await createApplication(baseConfig({
        idleSleepConfig: { enabled: true, idleCyclesBeforeSleep: 1 },
        watchdog: { disabled: true },
      }));
      createdApps.push(app);

      app.orchestrator.initializeSleeping();
      expect(app.orchestrator.getState()).toBe(LoopState.SLEEPING);

      await app.start(0, true);
      expect(app.orchestrator.getState()).toBe(LoopState.SLEEPING);
    });

    it("forceStart=true does start loop when initialized in STOPPED state", async () => {
      const app = await createApplication(baseConfig({
        idleSleepConfig: { enabled: true, idleCyclesBeforeSleep: 1 },
        watchdog: { disabled: true },
      }));
      createdApps.push(app);

      expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);

      await app.start(0, true);
      // Should have transitioned from STOPPED → RUNNING
      expect(app.orchestrator.getState()).not.toBe(LoopState.STOPPED);
    });
  });

  describe("idLauncher config", () => {
    it("creates application with idLauncher: 'claude' (explicit default)", async () => {
      const app = await createApplication(baseConfig({
        idLauncher: "claude",
      }));
      createdApps.push(app);

      expect(app).toBeDefined();
      expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("creates application without idLauncher (implicit default = claude behavior)", async () => {
      const app = await createApplication(baseConfig());
      createdApps.push(app);

      expect(app).toBeDefined();
      expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("creates application with idLauncher: 'vertex' and missing key file (falls back to default launcher)", async () => {
      const app = await createApplication(baseConfig({
        idLauncher: "vertex",
        vertexKeyPath: "/nonexistent-api-key.txt",
      }));
      createdApps.push(app);

      expect(app).toBeDefined();
      expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
    });

    it("creates application with idLauncher: 'ollama'", async () => {
      const app = await createApplication(baseConfig({
        idLauncher: "ollama",
        idOllamaModel: "deepseek-r1:70b",
        ollamaBaseUrl: "http://localhost:11434",
      }));
      createdApps.push(app);

      expect(app).toBeDefined();
      expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
    });
  });
});
