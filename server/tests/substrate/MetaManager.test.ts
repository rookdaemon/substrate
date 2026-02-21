import { MetaManager } from "../../src/substrate/MetaManager";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";

const SUBSTRATE_PATH = "/substrate";
const META_PATH = "/substrate/meta.json";
const FIXED_TIME = new Date("2024-06-15T12:00:00.000Z");

describe("MetaManager", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let manager: MetaManager;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(FIXED_TIME);
    manager = new MetaManager(fs, clock, SUBSTRATE_PATH);
  });

  describe("initialize()", () => {
    it("creates meta.json with default values when file does not exist", async () => {
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await manager.initialize();

      expect(await fs.exists(META_PATH)).toBe(true);
      const content = JSON.parse(await fs.readFile(META_PATH));
      expect(content.name).toBe("substrate");
      expect(content.fullName).toBe("substrate");
      expect(content.birthdate).toBe("2024-06-15T12:00:00.000Z");
    });

    it("derives name from the last path segment", async () => {
      const mgr = new MetaManager(fs, clock, "/data/my-agent");
      await fs.mkdir("/data/my-agent", { recursive: true });
      await mgr.initialize();

      const content = JSON.parse(await fs.readFile("/data/my-agent/meta.json"));
      expect(content.name).toBe("my-agent");
    });

    it("does not overwrite an existing meta.json", async () => {
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      const existing = { name: "custom", fullName: "Custom Agent", birthdate: "2023-01-01T00:00:00.000Z" };
      await fs.writeFile(META_PATH, JSON.stringify(existing));

      await manager.initialize();

      const content = JSON.parse(await fs.readFile(META_PATH));
      expect(content.name).toBe("custom");
      expect(content.fullName).toBe("Custom Agent");
      expect(content.birthdate).toBe("2023-01-01T00:00:00.000Z");
    });
  });

  describe("read()", () => {
    it("returns null when meta.json does not exist", async () => {
      const result = await manager.read();
      expect(result).toBeNull();
    });

    it("returns parsed meta when file exists", async () => {
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      const meta = { name: "alice", fullName: "Alice the Agent", birthdate: "2024-01-01T00:00:00.000Z" };
      await fs.writeFile(META_PATH, JSON.stringify(meta));

      const result = await manager.read();
      expect(result).toEqual(meta);
    });

    it("returns null when file contains invalid JSON", async () => {
      await fs.mkdir(SUBSTRATE_PATH, { recursive: true });
      await fs.writeFile(META_PATH, "not valid json");

      const result = await manager.read();
      expect(result).toBeNull();
    });

    it("rethrows unexpected errors", async () => {
      const brokenFs = {
        ...fs,
        readFile: async (_path: string) => { throw new Error("disk failure"); },
        exists: async (_path: string) => true,
        writeFile: async (_path: string, _content: string) => {},
        appendFile: async (_path: string, _content: string) => {},
        mkdir: async (_path: string) => {},
        stat: fs.stat.bind(fs),
        readdir: fs.readdir.bind(fs),
        copyFile: fs.copyFile.bind(fs),
        unlink: fs.unlink.bind(fs),
      };
      const failManager = new MetaManager(brokenFs as never, clock, SUBSTRATE_PATH);
      await expect(failManager.read()).rejects.toThrow("disk failure");
    });
  });
});
