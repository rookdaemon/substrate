import { InMemoryFileSystem } from "../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../src/substrate/config";
import { SubstrateValidator } from "../src/substrate/initialization/SubstrateValidator";
import { SubstrateFileType } from "../src/substrate/types";
import { initializeSubstrate } from "../src/startup";

describe("initializeSubstrate", () => {
  let fs: InMemoryFileSystem;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
  });

  it("creates all substrate files from templates", async () => {
    await initializeSubstrate(fs, "/substrate");

    const config = new SubstrateConfig("/substrate");
    for (const fileType of Object.values(SubstrateFileType)) {
      const exists = await fs.exists(config.getFilePath(fileType));
      expect(exists).toBe(true);
    }
  });

  it("validates substrate after initialization", async () => {
    await initializeSubstrate(fs, "/substrate");

    const config = new SubstrateConfig("/substrate");
    const validator = new SubstrateValidator(fs, config);
    const result = await validator.validate();
    expect(result.valid).toBe(true);
  });

  it("does not overwrite existing files", async () => {
    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nCustom plan content\n\n## Tasks\n\n- [ ] Custom task");

    await initializeSubstrate(fs, "/substrate");

    const content = await fs.readFile("/substrate/PLAN.md");
    expect(content).toContain("Custom plan content");
  });

  it("throws when validation fails after init", async () => {
    // Create a filesystem that produces corrupt files by overriding writeFile
    // to write empty content for one specific file
    const corruptFs = new InMemoryFileSystem();
    await corruptFs.mkdir("/substrate", { recursive: true });
    // Pre-create an empty PLAN.md that won't be overwritten by init
    await corruptFs.writeFile("/substrate/PLAN.md", "");

    // initializeSubstrate won't overwrite existing empty PLAN.md, but it's empty = invalid
    await expect(initializeSubstrate(corruptFs, "/substrate")).rejects.toThrow(
      "Substrate validation failed"
    );
  });
});
