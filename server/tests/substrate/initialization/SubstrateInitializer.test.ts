import { SubstrateInitializer } from "../../../src/substrate/initialization/SubstrateInitializer";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../../../src/substrate/config";
import { SubstrateFileType } from "../../../src/substrate/types";
import { getTemplate } from "../../../src/substrate/templates/index";

describe("SubstrateInitializer", () => {
  let fs: InMemoryFileSystem;
  let config: SubstrateConfig;
  let initializer: SubstrateInitializer;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    config = new SubstrateConfig("/substrate");
    initializer = new SubstrateInitializer(fs, config);
  });

  it("creates the substrate directory", async () => {
    await initializer.initialize();
    expect(await fs.exists("/substrate")).toBe(true);
  });

  it("creates all substrate files from templates", async () => {
    const report = await initializer.initialize();
    const totalFileTypes = Object.values(SubstrateFileType).length;

    for (const type of Object.values(SubstrateFileType)) {
      const path = config.getFilePath(type);
      expect(await fs.exists(path)).toBe(true);
      const content = await fs.readFile(path);
      expect(content).toBe(getTemplate(type));
    }

    expect(report.created).toHaveLength(totalFileTypes);
    expect(report.alreadyExisted).toHaveLength(0);
  });

  it("does NOT overwrite existing files", async () => {
    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Custom\n\nMy plan");

    const report = await initializer.initialize();
    const totalFileTypes = Object.values(SubstrateFileType).length;

    const planContent = await fs.readFile("/substrate/PLAN.md");
    expect(planContent).toBe("# Plan\n\n## Custom\n\nMy plan");
    expect(report.alreadyExisted).toContain(SubstrateFileType.PLAN);
    expect(report.created).not.toContain(SubstrateFileType.PLAN);
    expect(report.created).toHaveLength(totalFileTypes - 1);
  });

  it("creates only missing files when some already exist", async () => {
    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Goal\n\nExisting");
    await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nExisting");

    const report = await initializer.initialize();
    const totalFileTypes = Object.values(SubstrateFileType).length;

    expect(report.alreadyExisted).toContain(SubstrateFileType.PLAN);
    expect(report.alreadyExisted).toContain(SubstrateFileType.MEMORY);
    expect(report.created).toHaveLength(totalFileTypes - 2);
  });

  it("returns the full report", async () => {
    const report = await initializer.initialize();
    const totalFileTypes = Object.values(SubstrateFileType).length;
    expect(report.created.length + report.alreadyExisted.length).toBe(totalFileTypes);
  });
});
