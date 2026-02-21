import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { resolveConfig } from "../src/config";
import type { AppPaths } from "../src/paths";

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
    expect(config.model).toBe("sonnet");
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

  it("defaults superegoAuditInterval to 20", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.superegoAuditInterval).toBe(20);
  });

  it("uses cycleDelayMs from config file", async () => {
    await fs.mkdir("/project", { recursive: true });
    await fs.writeFile("/project/config.json", JSON.stringify({
      cycleDelayMs: 60000,
    }));

    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      cwd: "/project",
      env: {},
    });

    expect(config.cycleDelayMs).toBe(60000);
  });

  it("defaults cycleDelayMs to 30000", async () => {
    const config = await resolveConfig(fs, {
      appPaths: TEST_PATHS,
      env: {},
    });

    expect(config.cycleDelayMs).toBe(30000);
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
});
