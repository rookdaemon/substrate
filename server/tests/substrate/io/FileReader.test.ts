import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateFileType } from "../../../src/substrate/types";

describe("SubstrateFileReader", () => {
  let fs: InMemoryFileSystem;
  let config: SubstrateConfig;
  let reader: SubstrateFileReader;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    config = new SubstrateConfig("/substrate");
    reader = new SubstrateFileReader(fs, config);
  });

  it("reads a substrate file and returns content with metadata", async () => {
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Goal\n\nDo stuff");

    const result = await reader.read(SubstrateFileType.PLAN);

    expect(result.rawMarkdown).toBe("# Plan\n\n## Goal\n\nDo stuff");
    expect(result.meta.fileType).toBe(SubstrateFileType.PLAN);
    expect(result.meta.filePath).toBe("/substrate/PLAN.md");
    expect(result.meta.lastModified).toBeGreaterThan(0);
    expect(result.meta.contentHash).toBeTruthy();
  });

  it("returns different hashes for different content", async () => {
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## A\n\nContent A");
    const result1 = await reader.read(SubstrateFileType.PLAN);

    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## B\n\nContent B");
    const result2 = await reader.read(SubstrateFileType.PLAN);

    expect(result1.meta.contentHash).not.toBe(result2.meta.contentHash);
  });

  it("throws when file does not exist", async () => {
    await expect(reader.read(SubstrateFileType.PLAN)).rejects.toThrow();
  });

  describe("mtime-based cache (enableCache = true, default)", () => {
    it("records a cache miss on first read", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nContent");
      await reader.read(SubstrateFileType.PLAN);

      expect(reader.getMetrics()).toEqual({ cacheHits: 0, cacheMisses: 1 });
    });

    it("records a cache hit on second read with same mtime", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nContent");
      await reader.read(SubstrateFileType.PLAN);
      await reader.read(SubstrateFileType.PLAN);

      expect(reader.getMetrics()).toEqual({ cacheHits: 1, cacheMisses: 1 });
    });

    it("returns cached content on cache hit", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nContent");
      const first = await reader.read(SubstrateFileType.PLAN);
      const second = await reader.read(SubstrateFileType.PLAN);

      expect(second.rawMarkdown).toBe(first.rawMarkdown);
      expect(second.meta.contentHash).toBe(first.meta.contentHash);
    });

    it("records a cache miss when mtime changes", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nVersion 1");
      await reader.read(SubstrateFileType.PLAN);

      // Write new content (InMemoryFileSystem updates mtimeMs on each write)
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nVersion 2");
      await reader.read(SubstrateFileType.PLAN);

      expect(reader.getMetrics()).toEqual({ cacheHits: 0, cacheMisses: 2 });
    });

    it("returns updated content after mtime changes", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nVersion 1");
      await reader.read(SubstrateFileType.PLAN);

      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nVersion 2");
      const second = await reader.read(SubstrateFileType.PLAN);

      expect(second.rawMarkdown).toBe("# Plan\n\nVersion 2");
    });

    it("invalidate() clears the cache entry so next read is a miss", async () => {
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nContent");
      await reader.read(SubstrateFileType.PLAN);

      reader.invalidate("/substrate/PLAN.md");
      await reader.read(SubstrateFileType.PLAN);

      expect(reader.getMetrics()).toEqual({ cacheHits: 0, cacheMisses: 2 });
    });
  });

  describe("cache disabled (enableCache = false)", () => {
    it("never records cache hits or misses", async () => {
      const uncachedReader = new SubstrateFileReader(fs, config, false);
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nContent");

      await uncachedReader.read(SubstrateFileType.PLAN);
      await uncachedReader.read(SubstrateFileType.PLAN);

      expect(uncachedReader.getMetrics()).toEqual({ cacheHits: 0, cacheMisses: 0 });
    });

    it("always reads from filesystem", async () => {
      const uncachedReader = new SubstrateFileReader(fs, config, false);
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nVersion 1");
      const first = await uncachedReader.read(SubstrateFileType.PLAN);

      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\nVersion 2");
      const second = await uncachedReader.read(SubstrateFileType.PLAN);

      expect(first.rawMarkdown).toBe("# Plan\n\nVersion 1");
      expect(second.rawMarkdown).toBe("# Plan\n\nVersion 2");
    });
  });

  describe("cache invalidation on write via SubstrateFileWriter", () => {
    it("invalidates cache entry after FileWriter.write()", async () => {
      const lock = new FileLock();
      const writer = new SubstrateFileWriter(fs, config, lock, reader);

      await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nOriginal");
      await reader.read(SubstrateFileType.MEMORY); // populate cache (1 miss)

      await writer.write(SubstrateFileType.MEMORY, "# Memory\n\nUpdated");
      const result = await reader.read(SubstrateFileType.MEMORY); // must be a miss, not a hit

      expect(result.rawMarkdown).toBe("# Memory\n\nUpdated");
      expect(reader.getMetrics()).toEqual({ cacheHits: 0, cacheMisses: 2 });
    });
  });

  describe("cache invalidation on append via AppendOnlyWriter", () => {
    it("invalidates cache entry after AppendOnlyWriter.append()", async () => {
      const clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));
      const lock = new FileLock();
      const appendWriter = new AppendOnlyWriter(fs, config, lock, clock, reader);

      await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
      await reader.read(SubstrateFileType.PROGRESS); // populate cache (1 miss)

      await appendWriter.append(SubstrateFileType.PROGRESS, "New entry");
      const result = await reader.read(SubstrateFileType.PROGRESS); // must be a miss, not a hit

      expect(result.rawMarkdown).toContain("New entry");
      expect(reader.getMetrics()).toEqual({ cacheHits: 0, cacheMisses: 2 });
    });
  });
});
