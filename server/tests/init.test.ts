import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../src/substrate/config";
import { SubstrateFileType } from "../src/substrate/types";
import { initWorkspace } from "../src/init";
import type { RookConfig } from "../src/config";
import type { AppPaths } from "../src/paths";

const TEST_PATHS: AppPaths = {
  config: "/xdg/config/rook-wiggums",
  data: "/xdg/data/rook-wiggums",
};

const TEST_CONFIG: RookConfig = {
  substratePath: "/xdg/data/rook-wiggums/substrate",
  workingDirectory: "/xdg/data/rook-wiggums",
  port: 3000,
};

describe("initWorkspace", () => {
  let fs: InMemoryFileSystem;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
  });

  it("creates working directory and config directory", async () => {
    await initWorkspace(fs, TEST_CONFIG, TEST_PATHS);

    expect(await fs.exists(TEST_CONFIG.workingDirectory)).toBe(true);
    expect(await fs.exists(TEST_PATHS.config)).toBe(true);
  });

  it("writes config.json into config directory", async () => {
    await initWorkspace(fs, TEST_CONFIG, TEST_PATHS);

    const configPath = `${TEST_PATHS.config}/config.json`;
    expect(await fs.exists(configPath)).toBe(true);

    const content = JSON.parse(await fs.readFile(configPath));
    expect(content.substratePath).toBe(TEST_CONFIG.substratePath);
    expect(content.workingDirectory).toBe(TEST_CONFIG.workingDirectory);
    expect(content.port).toBe(TEST_CONFIG.port);
  });

  it("does not overwrite existing config.json", async () => {
    await fs.mkdir(TEST_PATHS.config, { recursive: true });
    await fs.writeFile(
      `${TEST_PATHS.config}/config.json`,
      JSON.stringify({ port: 9999 })
    );

    await initWorkspace(fs, TEST_CONFIG, TEST_PATHS);

    const content = JSON.parse(
      await fs.readFile(`${TEST_PATHS.config}/config.json`)
    );
    expect(content.port).toBe(9999);
  });

  it("initializes substrate files", async () => {
    await initWorkspace(fs, TEST_CONFIG, TEST_PATHS);

    const substrateConfig = new SubstrateConfig(TEST_CONFIG.substratePath);
    for (const fileType of Object.values(SubstrateFileType)) {
      const exists = await fs.exists(substrateConfig.getFilePath(fileType));
      expect(exists).toBe(true);
    }
  });
});
