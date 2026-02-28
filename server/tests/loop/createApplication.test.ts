import { mkdtempSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createApplication, ApplicationConfig, Application } from "../../src/loop/createApplication";
import { LoopState } from "../../src/loop/types";
import type { SdkQueryFn } from "../../src/agents/claude/AgentSdkLauncher";

const mockSdkQuery: SdkQueryFn = async function* () {
  yield { type: "unused" };
};

describe("createApplication", () => {
  const createdApps: Application[] = [];
  let tempDir: string;

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), "substrate-test-"));
  });

  afterEach(async () => {
    for (const app of createdApps) {
      try {
        await app.stop();
      } catch {
        // ignore
      }
    }
    createdApps.length = 0;
    rmSync(tempDir, { recursive: true, force: true });
  });

  function baseConfig(overrides?: Partial<ApplicationConfig>): ApplicationConfig {
    return {
      substratePath: join(tempDir, "substrate"),
      sdkQueryFn: mockSdkQuery,
      ...overrides,
    };
  }

  it("creates an application with all components wired", async () => {
    const app = await createApplication(baseConfig({
      httpPort: 0,
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
      httpPort: 0,
      cycleDelayMs: 500,
      superegoAuditInterval: 5,
      maxConsecutiveIdleCycles: 3,
    }));
    createdApps.push(app);

    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("provides start and stop methods", async () => {
    const app = await createApplication(baseConfig({
      httpPort: 0,
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
      httpPort: 0,
      watchdog: { disabled: true },
    }));
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });

  it("creates application successfully with custom watchdog timing", async () => {
    const app = await createApplication(baseConfig({
      httpPort: 0,
      watchdog: { stallThresholdMs: 5 * 60 * 1000, checkIntervalMs: 60 * 1000 },
    }));
    createdApps.push(app);

    expect(app).toBeDefined();
    expect(app.orchestrator.getState()).toBe(LoopState.STOPPED);
  });
});
