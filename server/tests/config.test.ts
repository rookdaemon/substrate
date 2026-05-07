import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { resolveConfig, ConfigValidationError } from "../src/config";
import type { AppPaths } from "../src/paths";
import { MIN_SURVIVAL_ROUTINE_CYCLE_DELAY_MS } from "../src/loop/types";

const TEST_PATHS: AppPaths = {
  config: "/xdg/config/substrate",
  data: "/xdg/data/substrate",
};

describe("resolveConfig", () => {
  let fs: InMemoryFileSystem;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
  });

  it("returns defaults when no config file exists", async () => {
    const config = await resolveConfig(fs, { appPaths: TEST_PATHS, env: {} });

    expect(config.substratePath).toBe("/xdg/data/substrate");
    expect(config.workingDirectory).toBe("/xdg/data/substrate");
    expect(config.backupPath).toBe("/xdg/data/substrate-backups");
    expect(config.port).toBe(3000);
    expect(config.model).toBe("claude-haiku-4-5");
    expect(config.strategicModel).toBe("claude-sonnet-4-6");
    expect(config.tacticalModel).toBe("claude-sonnet-4-6");
  });

  it("loads from explicit configPath", async () => {
    await fs.mkdir("/custom", { recursive: true });
    await fs.writeFile("/custom/config.json", JSON.stringify({
      substratePath: "/my/substrate",
      port: 8080,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      configPath: "/custom/config.json",
      env: {},
    });

    expect(config.substratePath).toBe("/my/substrate");
    expect(config.port).toBe(8080);
    expect(config.workingDirectory).toBe("/xdg/data/substrate");
  });

  it("errors if explicit configPath is missing", async () => {
    await expect(
      resolveConfig(fs, {
        appPaths: TEST_PATHS,
        configPath: "/missing/config.json",
        env: {},
      })
    ).rejects.toThrow("Config file not found: /missing/config.json");
  });

  it("loads from CWD config.json when present", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({ port: 4000 }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.port).toBe(4000);
    expect(config.substratePath).toBe("/xdg/data/substrate");
  });

  it("falls back to config-dir config.json when CWD has none", async () => {
    await fs.mkdir(TEST_PATHS.config, { recursive: true });
    await fs.writeFile(
      `${TEST_PATHS.config}/config.json`,
      JSON.stringify({ port: 5000, substratePath: "/shared/substrate" })
    );

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/empty-project",
      env: {},
    });

    expect(config.port).toBe(5000);
    expect(config.substratePath).toBe("/shared/substrate");
  });

  it("CWD takes priority over config-dir", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({ port: 4000 }));

    await fs.mkdir(TEST_PATHS.config, { recursive: true });
    await fs.writeFile(
      `${TEST_PATHS.config}/config.json`,
      JSON.stringify({ port: 5000 })
    );

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.port).toBe(4000);
  });

  it("merges partial config with defaults", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({ port: 9000 }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.port).toBe(9000);
    expect(config.substratePath).toBe("/xdg/data/substrate");
    expect(config.workingDirectory).toBe("/xdg/data/substrate");
  });

  it("reads model from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({ model: "opus" }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.model).toBe("opus");
  });

  it("defaults sourceCodePath to cwd", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/home/stefan/substrate",
      env: {},
    });

    expect(config.sourceCodePath).toBe("/home/stefan/substrate");
  });

  it("uses sourceCodePath from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      sourceCodePath: "/opt/my-project",
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.sourceCodePath).toBe("/opt/my-project");
  });

  it("uses backupPath from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      backupPath: "/mnt/backups/substrate",
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.backupPath).toBe("/mnt/backups/substrate");
  });

  it("uses backupRetentionCount from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      backupRetentionCount: 30,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.backupRetentionCount).toBe(30);
  });

  it("defaults backupRetentionCount to 14", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.backupRetentionCount).toBe(14);
  });

  it("env vars override config file values", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      substratePath: "/file/substrate",
      port: 4000,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {
        SUBSTRATE_PATH: "/env/substrate",
        PORT: "7777",
      },
    });

    expect(config.substratePath).toBe("/env/substrate");
    expect(config.port).toBe(7777);
  });

  it("SUPEREGO_AUDIT_INTERVAL env var overrides config", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      superegoAuditInterval: 15,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {
        SUPEREGO_AUDIT_INTERVAL: "30",
      },
    });

    expect(config.superegoAuditInterval).toBe(30);
  });

  it("defaults superegoAuditInterval to 50", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.superegoAuditInterval).toBe(50);
  });

  it("uses dynamicSuperegoAudit from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      dynamicSuperegoAudit: {
        enabled: true,
        materialIntervalCycles: 960,
        idleIntervalCycles: 2880,
        maxIntervalMs: 8 * 60 * 60 * 1000,
      },
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.dynamicSuperegoAudit).toEqual({
      enabled: true,
      materialIntervalCycles: 960,
      idleIntervalCycles: 2880,
      maxIntervalMs: 8 * 60 * 60 * 1000,
    });
  });

  it("clamps cycleDelayMs from config file below the survival minimum", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      cycleDelayMs: 60000,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.cycleDelayMs).toBe(MIN_SURVIVAL_ROUTINE_CYCLE_DELAY_MS);
  });

  it("uses cycleDelayMs from config file at or above the survival minimum", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      cycleDelayMs: MIN_SURVIVAL_ROUTINE_CYCLE_DELAY_MS + 1000,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.cycleDelayMs).toBe(MIN_SURVIVAL_ROUTINE_CYCLE_DELAY_MS + 1000);
  });

  it("defaults cycleDelayMs to the survival minimum", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.cycleDelayMs).toBe(MIN_SURVIVAL_ROUTINE_CYCLE_DELAY_MS);
  });

  it("defaults conversationIdleTimeoutMs to 20000", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.conversationIdleTimeoutMs).toBe(20000);
  });

  it("uses conversationIdleTimeoutMs from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      conversationIdleTimeoutMs: 25000,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.conversationIdleTimeoutMs).toBe(25000);
  });

  it("idleSleepConfig defaults to undefined", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.idleSleepConfig).toBeUndefined();
  });

  it("reads idleSleepConfig from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      idleSleepConfig: { enabled: true, idleCyclesBeforeSleep: 3 },
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.idleSleepConfig?.enabled).toBe(true);
    expect(config.idleSleepConfig?.idleCyclesBeforeSleep).toBe(3);
  });

  it("idleSleepConfig uses defaults for missing fields", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      idleSleepConfig: {},
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.idleSleepConfig?.enabled).toBe(false);
    expect(config.idleSleepConfig?.idleCyclesBeforeSleep).toBe(5);
  });

  it("evaluateOutcome defaults to disabled with qualityThreshold 70", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.evaluateOutcome?.enabled).toBe(false);
    expect(config.evaluateOutcome?.qualityThreshold).toBe(85);
  });

  it("reads evaluateOutcome from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      evaluateOutcome: { enabled: true, qualityThreshold: 80 },
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.evaluateOutcome?.enabled).toBe(true);
    expect(config.evaluateOutcome?.qualityThreshold).toBe(80);
  });

  it("apiToken defaults to undefined", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.apiToken).toBeUndefined();
  });

  it("reads apiToken from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      apiToken: "my-secret-token",
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.apiToken).toBe("my-secret-token");
  });

  describe("validation errors (ConfigValidationError)", () => {
    async function writeConfig(obj: unknown): Promise<void> {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify(obj));
    }

    const opts = { appPaths: TEST_PATHS, cwd: "/project", env: {} };

    it("throws ConfigValidationError for out-of-range port (0)", async () => {
      await writeConfig({ port: 0 });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
      await expect(resolveConfig(fs, opts)).rejects.toThrow("Invalid config.json:");
    });

    it("throws ConfigValidationError for out-of-range port (65536)", async () => {
      await writeConfig({ port: 65536 });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
    });

    it("throws ConfigValidationError for invalid mode string", async () => {
      await writeConfig({ mode: "batch" });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
      await expect(resolveConfig(fs, opts)).rejects.toThrow("Invalid config.json:");
    });

    it("throws ConfigValidationError for invalid logLevel string", async () => {
      await writeConfig({ logLevel: "verbose" });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
      await expect(resolveConfig(fs, opts)).rejects.toThrow("Invalid config.json:");
    });

    it("clamps minute-poll cycleDelayMs before validating conversationIdleTimeoutMs", async () => {
      await writeConfig({ cycleDelayMs: 10000, conversationIdleTimeoutMs: 20000 });
      const config = await resolveConfig(fs, opts);
      expect(config.cycleDelayMs).toBe(MIN_SURVIVAL_ROUTINE_CYCLE_DELAY_MS);
      expect(config.conversationIdleTimeoutMs).toBe(20000);
    });

    it("clamps equal low cycleDelayMs before validating conversationIdleTimeoutMs", async () => {
      await writeConfig({ cycleDelayMs: 20000, conversationIdleTimeoutMs: 20000 });
      const config = await resolveConfig(fs, opts);
      expect(config.cycleDelayMs).toBe(MIN_SURVIVAL_ROUTINE_CYCLE_DELAY_MS);
      expect(config.conversationIdleTimeoutMs).toBe(20000);
    });

    it("throws ConfigValidationError for idleCyclesBeforeSleep < 1", async () => {
      await writeConfig({ idleSleepConfig: { enabled: true, idleCyclesBeforeSleep: 0 } });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
    });

    it("throws ConfigValidationError for email.sendTimeHour out of range", async () => {
      await writeConfig({ email: { enabled: true, intervalHours: 24, sendTimeHour: 24, sendTimeMinute: 0 } });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
    });

    it("throws ConfigValidationError for email.sendTimeMinute out of range", async () => {
      await writeConfig({ email: { enabled: true, intervalHours: 24, sendTimeHour: 5, sendTimeMinute: 60 } });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
    });

    it("throws ConfigValidationError for qualityThreshold > 100", async () => {
      await writeConfig({ evaluateOutcome: { enabled: true, qualityThreshold: 101 } });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
    });

    it("rejects sessionLauncher: 'vertex' with specific error (cognitive role guard)", async () => {
      await writeConfig({ sessionLauncher: "vertex" });
      await expect(resolveConfig(fs, opts)).rejects.toThrow("not allowed for cognitive roles");
    });

    it("rejects idLauncher: 'vertex' without vertexKeyPath", async () => {
      await writeConfig({ idLauncher: "vertex" });
      await expect(resolveConfig(fs, opts)).rejects.toThrow("idLauncher: \"vertex\" requires vertexKeyPath to be set");
    });

    it("rejects invalid idLauncher value", async () => {
      await writeConfig({ idLauncher: "gemini" });
      await expect(resolveConfig(fs, opts)).rejects.toThrow(ConfigValidationError);
    });

    it("accepts idLauncher: 'ollama' without any additional requirements", async () => {
      await writeConfig({ idLauncher: "ollama" });
      const config = await resolveConfig(fs, opts);
      expect(config.idLauncher).toBe("ollama");
    });

    it("accepts sessionLauncher: 'codex'", async () => {
      await writeConfig({ sessionLauncher: "codex" });
      const config = await resolveConfig(fs, opts);
      expect(config.sessionLauncher).toBe("codex");
    });

    it("accepts sessionLauncher: 'pi'", async () => {
      await writeConfig({ sessionLauncher: "pi" });
      const config = await resolveConfig(fs, opts);
      expect(config.sessionLauncher).toBe("pi");
    });

    it("accepts defaultCodeBackend: 'codex'", async () => {
      await writeConfig({ defaultCodeBackend: "codex" });
      const config = await resolveConfig(fs, opts);
      expect(config.defaultCodeBackend).toBe("codex");
    });
  });

  describe("vertex config", () => {
    it("reads vertexKeyPath from config file", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        vertexKeyPath: "/home/rook/.config/google/google_api_key.txt",
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.vertexKeyPath).toBe("/home/rook/.config/google/google_api_key.txt");
    });

    it("reads vertexModel from config file", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        vertexModel: "gemini-1.5-flash",
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.vertexModel).toBe("gemini-1.5-flash");
    });

    it("defaults vertexKeyPath and vertexModel to undefined", async () => {
      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        env: {},
      });

      expect(config.vertexKeyPath).toBeUndefined();
      expect(config.vertexModel).toBeUndefined();
    });

    it("reads idLauncher: 'vertex' with vertexKeyPath set", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        idLauncher: "vertex",
        vertexKeyPath: "/home/rook/.config/google/google_api_key.txt",
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.idLauncher).toBe("vertex");
      expect(config.vertexKeyPath).toBe("/home/rook/.config/google/google_api_key.txt");
    });

    it("reads idLauncher: 'claude' as explicit value", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        idLauncher: "claude",
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.idLauncher).toBe("claude");
    });

    it("defaults idLauncher to undefined (absent = claude behavior)", async () => {
      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        env: {},
      });

      expect(config.idLauncher).toBeUndefined();
    });

    it("reads idOllamaModel from config file", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        idLauncher: "ollama",
        idOllamaModel: "deepseek-r1:70b",
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.idLauncher).toBe("ollama");
      expect(config.idOllamaModel).toBe("deepseek-r1:70b");
    });

    it("defaults idOllamaModel to undefined when absent", async () => {
      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        env: {},
      });

      expect(config.idOllamaModel).toBeUndefined();
    });
  });

  describe("provider config blocks", () => {
    it("resolves model from the active provider block", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "claude",
        claude: {
          model: "claude-sonnet-4-5",
          strategicModel: "claude-opus-4-5",
          tacticalModel: "claude-haiku-4-5",
        },
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.model).toBe("claude-sonnet-4-5");
      expect(config.strategicModel).toBe("claude-opus-4-5");
      expect(config.tacticalModel).toBe("claude-haiku-4-5");
    });

    it("resolves model for the active sessionLauncher, not other providers", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "gemini",
        claude: {
          model: "claude-sonnet-4-5",
          strategicModel: "claude-opus-4-5",
          tacticalModel: "claude-haiku-4-5",
        },
        gemini: {
          model: "gemini-2.5-pro",
          strategicModel: "gemini-2.5-pro",
          tacticalModel: "gemini-2.5-flash",
        },
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.model).toBe("gemini-2.5-pro");
      expect(config.strategicModel).toBe("gemini-2.5-pro");
      expect(config.tacticalModel).toBe("gemini-2.5-flash");
    });

    it("resolves Pi provider block model and shell settings", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "pi",
        pi: {
          provider: "openai",
          model: "gpt-5.5",
          strategicModel: "gpt-5.5",
          tacticalModel: "gpt-5.4",
          mode: "json",
          sessionDir: "/substrate/pi-sessions",
        },
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.model).toBe("gpt-5.5");
      expect(config.strategicModel).toBe("gpt-5.5");
      expect(config.tacticalModel).toBe("gpt-5.4");
      expect(config.pi).toEqual({
        provider: "openai",
        model: "gpt-5.5",
        strategicModel: "gpt-5.5",
        tacticalModel: "gpt-5.4",
        mode: "json",
        sessionDir: "/substrate/pi-sessions",
      });
    });

    it("rejects invalid Pi shell mode", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "pi",
        pi: { mode: "rpc" },
      }));

      await expect(resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      })).rejects.toThrow(ConfigValidationError);
    });

    it("falls back to legacy flat fields when models block is absent", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        model: "claude-sonnet-4-5",
        strategicModel: "claude-opus-4-5",
        tacticalModel: "claude-haiku-4-5",
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.model).toBe("claude-sonnet-4-5");
      expect(config.strategicModel).toBe("claude-opus-4-5");
      expect(config.tacticalModel).toBe("claude-haiku-4-5");
    });

    it("provider block takes priority over deprecated models map and legacy flat fields", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "claude",
        model: "legacy-model",
        strategicModel: "legacy-strategic",
        tacticalModel: "legacy-tactical",
        claude: {
          model: "claude-sonnet-4-5",
          strategicModel: "claude-opus-4-5",
          tacticalModel: "claude-haiku-4-5",
        },
        models: {
          claude: {
            model: "deprecated-model",
            strategicModel: "deprecated-strategic",
            tacticalModel: "deprecated-tactical",
          },
        },
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.model).toBe("claude-sonnet-4-5");
      expect(config.strategicModel).toBe("claude-opus-4-5");
      expect(config.tacticalModel).toBe("claude-haiku-4-5");
    });

    it("uses defaults when provider config has no entry for the active launcher", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "claude",
        gemini: {
          model: "gemini-2.5-pro",
        },
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.model).toBe("claude-haiku-4-5");
      expect(config.gemini).toEqual({ model: "gemini-2.5-pro" });
    });

    it("partial provider block falls back to legacy flat fields then defaults", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "claude",
        model: "legacy-model",
        claude: {
          strategicModel: "claude-opus-4-5",
        },
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.model).toBe("legacy-model");
      expect(config.strategicModel).toBe("claude-opus-4-5");
      expect(config.tacticalModel).toBe("claude-sonnet-4-6");
    });

    it("resolves provider endpoint fields from nested provider blocks", async () => {
      await fs.mkdir("/project", { recursive: true });
      await fs.writeFile("/project/config.json", JSON.stringify({
        ollama: {
          baseUrl: "http://localhost:11434",
          keyPath: "/secrets/ollama.key",
          model: "qwen3:14b",
          idModel: "qwen3:8b",
        },
        groq: {
          keyPath: "/secrets/groq.key",
          model: "llama3-70b-8192",
          idModel: "llama3-8b-8192",
        },
        vertex: {
          keyPath: "/secrets/google.key",
          model: "gemini-2.5-flash",
        },
        anthropic: {
          keyPath: "/secrets/anthropic.json",
          model: "claude-sonnet-4",
          idModel: "claude-haiku-4",
        },
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.ollamaBaseUrl).toBe("http://localhost:11434");
      expect(config.ollamaKeyPath).toBe("/secrets/ollama.key");
      expect(config.ollamaModel).toBe("qwen3:14b");
      expect(config.idOllamaModel).toBe("qwen3:8b");
      expect(config.groqKeyPath).toBe("/secrets/groq.key");
      expect(config.groqModel).toBe("llama3-70b-8192");
      expect(config.idGroqModel).toBe("llama3-8b-8192");
      expect(config.vertexKeyPath).toBe("/secrets/google.key");
      expect(config.vertexModel).toBe("gemini-2.5-flash");
      expect(config.claudeOAuthKeyPath).toBe("/secrets/anthropic.json");
      expect(config.anthropicModel).toBe("claude-sonnet-4");
      expect(config.idAnthropicModel).toBe("claude-haiku-4");
    });

    it("preserves provider blocks in resolved config", async () => {
      await fs.mkdir("/project", { recursive: true });
      const claude = { model: "claude-sonnet-4-5", strategicModel: "claude-opus-4-5", tacticalModel: "claude-haiku-4-5" };
      const gemini = { model: "gemini-2.5-pro" };
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "claude",
        claude,
        gemini,
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.claude).toEqual(claude);
      expect(config.gemini).toEqual(gemini);
    });

    it("supports deprecated models map as fallback", async () => {
      await fs.mkdir("/project", { recursive: true });
      const modelsMap = {
        claude: { model: "claude-sonnet-4-5", strategicModel: "claude-opus-4-5", tacticalModel: "claude-haiku-4-5" },
        gemini: { model: "gemini-2.5-pro" },
      };
      await fs.writeFile("/project/config.json", JSON.stringify({
        sessionLauncher: "claude",
        models: modelsMap,
      }));

      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        cwd: "/project",
        env: {},
      });

      expect(config.models).toEqual(modelsMap);
      expect(config.model).toBe("claude-sonnet-4-5");
    });

    it("defaults models to undefined when not in config file", async () => {
      const config = await resolveConfig(fs, {
        appPaths: TEST_PATHS,
        env: {},
      });

      expect(config.models).toBeUndefined();
    });
  });
});
