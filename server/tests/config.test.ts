import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { resolveConfig } from "../src/config";
import type { AppPaths } from "../src/paths";

const TEST_PATHS: AppPaths = {
  config: "/xdg/config/rook-wiggums",
  data: "/xdg/data/rook-wiggums",
};

describe("resolveConfig", () => {
  let fs: InMemoryFileSystem;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
  });

  it("returns defaults when no config file exists", async () => {
    const config = await resolveConfig(fs, { appPaths: TEST_PATHS, env: {} });

    expect(config.substratePath).toBe("/xdg/data/rook-wiggums/substrate");
    expect(config.workingDirectory).toBe("/xdg/data/rook-wiggums");
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
    expect(config.workingDirectory).toBe("/xdg/data/rook-wiggums");
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
    expect(config.substratePath).toBe("/xdg/data/rook-wiggums/substrate");
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
    expect(config.substratePath).toBe("/xdg/data/rook-wiggums/substrate");
    expect(config.workingDirectory).toBe("/xdg/data/rook-wiggums");
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
});
