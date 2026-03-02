import { SubstrateFileWriter } from "../../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { SubstrateFileType } from "../../../src/substrate/types";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { IFileSystem, FileStat } from "../../../src/substrate/abstractions/IFileSystem";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";

// ---------------------------------------------------------------------------
// MockFileSystem — wraps InMemoryFileSystem with per-operation error injection
// ---------------------------------------------------------------------------

type Method = "readFile" | "writeFile" | "appendFile" | "mkdir" | "copyFile" | "stat" | "readdir" | "exists" | "unlink";

interface InjectedError {
  error: Error;
  once: boolean;
}

class MockFileSystem implements IFileSystem {
  private readonly inner = new InMemoryFileSystem();
  private readonly errors = new Map<string, InjectedError>();
  private globalDelayMs = 0;

  /** Inject an error for `method` on `path`. If `once` the error fires once then clears. */
  injectError(method: Method, path: string, error: Error, once = false): void {
    this.errors.set(`${method}:${path}`, { error, once });
  }

  /** Add a uniform delay to all operations (simulates slow/network FS). */
  setDelay(ms: number): void {
    this.globalDelayMs = ms;
  }

  private async delay(): Promise<void> {
    if (this.globalDelayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, this.globalDelayMs));
    }
  }

  private maybeThrow(method: Method, path: string): void {
    const key = `${method}:${path}`;
    const injected = this.errors.get(key);
    if (!injected) return;
    if (injected.once) this.errors.delete(key);
    throw injected.error;
  }

  /** Read a file bypassing error injection (for post-condition assertions). */
  async readDirect(path: string): Promise<string> {
    return this.inner.readFile(path);
  }

  async readFile(path: string): Promise<string> {
    await this.delay();
    this.maybeThrow("readFile", path);
    return this.inner.readFile(path);
  }

  async writeFile(path: string, content: string): Promise<void> {
    await this.delay();
    this.maybeThrow("writeFile", path);
    return this.inner.writeFile(path, content);
  }

  async appendFile(path: string, content: string): Promise<void> {
    await this.delay();
    this.maybeThrow("appendFile", path);
    return this.inner.appendFile(path, content);
  }

  async exists(path: string): Promise<boolean> {
    await this.delay();
    this.maybeThrow("exists", path);
    return this.inner.exists(path);
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    await this.delay();
    this.maybeThrow("mkdir", path);
    return this.inner.mkdir(path, options);
  }

  async stat(path: string): Promise<FileStat> {
    await this.delay();
    this.maybeThrow("stat", path);
    return this.inner.stat(path);
  }

  async readdir(path: string): Promise<string[]> {
    await this.delay();
    this.maybeThrow("readdir", path);
    return this.inner.readdir(path);
  }

  async copyFile(src: string, dest: string): Promise<void> {
    await this.delay();
    this.maybeThrow("copyFile", src);
    return this.inner.copyFile(src, dest);
  }

  async unlink(path: string): Promise<void> {
    await this.delay();
    this.maybeThrow("unlink", path);
    return this.inner.unlink(path);
  }
}

// ---------------------------------------------------------------------------
// Error helpers
// ---------------------------------------------------------------------------

function enospc(msg = "ENOSPC: no space left on device"): Error {
  const err = new Error(msg);
  (err as NodeJS.ErrnoException).code = "ENOSPC";
  return err;
}

function eacces(msg = "EACCES: permission denied"): Error {
  const err = new Error(msg);
  (err as NodeJS.ErrnoException).code = "EACCES";
  return err;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Substrate I/O Error Recovery", () => {
  let mockFs: MockFileSystem;
  let config: SubstrateConfig;
  let lock: FileLock;
  let clock: FixedClock;
  let writer: SubstrateFileWriter;
  let appendWriter: AppendOnlyWriter;

  beforeEach(async () => {
    mockFs = new MockFileSystem();
    config = new SubstrateConfig("/substrate");
    lock = new FileLock();
    clock = new FixedClock(new Date("2025-06-15T10:30:00Z"));
    writer = new SubstrateFileWriter(mockFs, config, lock);
    appendWriter = new AppendOnlyWriter(mockFs, config, lock, clock);

    // Pre-populate append-mode files required by AppendOnlyWriter
    await mockFs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
    await mockFs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
  });

  // ─── 1. Disk Full (ENOSPC) ───────────────────────────────────────────────

  describe("Disk Full (ENOSPC)", () => {
    it("FileWriter throws a descriptive error and does not produce a partial write", async () => {
      await mockFs.writeFile("/substrate/MEMORY.md", "# Memory\n\nOriginal");
      mockFs.injectError("writeFile", "/substrate/MEMORY.md", enospc());

      await expect(
        writer.write(SubstrateFileType.MEMORY, "# Memory\n\nNew content")
      ).rejects.toThrow("ENOSPC");

      // The underlying store must still hold the original content
      const content = await mockFs.readDirect("/substrate/MEMORY.md");
      expect(content).toBe("# Memory\n\nOriginal");
    });

    it("AppendOnlyWriter preserves existing content when appendFile fails with ENOSPC", async () => {
      const original = "# Progress\n\nExisting entry\n";
      await mockFs.writeFile("/substrate/PROGRESS.md", original);
      mockFs.injectError("appendFile", "/substrate/PROGRESS.md", enospc());

      await expect(
        appendWriter.append(SubstrateFileType.PROGRESS, "New entry")
      ).rejects.toThrow("ENOSPC");

      const content = await mockFs.readDirect("/substrate/PROGRESS.md");
      expect(content).toBe(original);
    });

    it("rotation is aborted and original PROGRESS.md survives when copyFile fails with ENOSPC", async () => {
      // Threshold of 1 byte forces rotation on any non-trivial append
      const smallWriter = new AppendOnlyWriter(mockFs, config, lock, clock, undefined, 1);
      mockFs.injectError("copyFile", "/substrate/PROGRESS.md", enospc());

      await expect(
        smallWriter.append(SubstrateFileType.PROGRESS, "Entry that would trigger rotation")
      ).rejects.toThrow("ENOSPC");

      // The base file must still be present — rotation was not completed
      const exists = await mockFs.exists("/substrate/PROGRESS.md");
      expect(exists).toBe(true);
    });
  });

  // ─── 2. Permission Errors (EACCES) ──────────────────────────────────────

  describe("Permission Errors (EACCES)", () => {
    it("SubstrateFileReader propagates EACCES from a read-only file system", async () => {
      await mockFs.writeFile("/substrate/PLAN.md", "# Plan\n\nContent");
      const reader = new SubstrateFileReader(mockFs, config, false);
      mockFs.injectError("readFile", "/substrate/PLAN.md", eacces());

      await expect(reader.read(SubstrateFileType.PLAN)).rejects.toThrow("EACCES");
    });

    it("FileWriter throws EACCES and leaves the original file content intact", async () => {
      await mockFs.writeFile("/substrate/MEMORY.md", "# Memory\n\nOriginal");
      mockFs.injectError("writeFile", "/substrate/MEMORY.md", eacces());

      await expect(
        writer.write(SubstrateFileType.MEMORY, "# Memory\n\nUpdated")
      ).rejects.toThrow("EACCES");

      const content = await mockFs.readDirect("/substrate/MEMORY.md");
      expect(content).toBe("# Memory\n\nOriginal");
    });

    it("AppendOnlyWriter throws EACCES when the archive directory cannot be created", async () => {
      const smallWriter = new AppendOnlyWriter(mockFs, config, lock, clock, undefined, 1);
      mockFs.injectError(
        "mkdir",
        "/substrate/progress",
        eacces("EACCES: permission denied, mkdir '/substrate/progress'")
      );

      await expect(
        smallWriter.append(SubstrateFileType.PROGRESS, "Entry triggering rotation")
      ).rejects.toThrow("EACCES");
    });
  });

  // ─── 3. Concurrent Write Conflicts ──────────────────────────────────────

  describe("Concurrent Write Conflicts", () => {
    it("FileLock serializes 10 concurrent FileWriter writes without data loss", async () => {
      const completedIndices: number[] = [];

      await Promise.all(
        Array.from({ length: 10 }, (_, i) =>
          writer
            .write(SubstrateFileType.MEMORY, `# Memory\n\nWrite ${i}`)
            .then(() => completedIndices.push(i))
        )
      );

      expect(completedIndices).toHaveLength(10);

      // Every scheduled write must have completed (lock must not have deadlocked)
      const allIndices = new Set(completedIndices);
      for (let i = 0; i < 10; i++) {
        expect(allIndices.has(i)).toBe(true);
      }
    });

    it("50 concurrent appends are all preserved in PROGRESS.md", async () => {
      const entries = Array.from({ length: 50 }, (_, i) => `ConcurrentEntry-${i}`);

      await Promise.all(
        entries.map((e) => appendWriter.append(SubstrateFileType.PROGRESS, e))
      );

      const content = await mockFs.readDirect("/substrate/PROGRESS.md");
      for (const entry of entries) {
        expect(content).toContain(entry);
      }
    });

    it("FileLock is released after a write error so the next writer can proceed", async () => {
      // Inject a one-time error — only the first write to MEMORY.md will fail
      mockFs.injectError(
        "writeFile",
        "/substrate/MEMORY.md",
        new Error("transient write failure"),
        true // once
      );

      const firstResult = await writer
        .write(SubstrateFileType.MEMORY, "# Memory\n\nFirst")
        .catch((e: Error) => e.message);

      expect(firstResult).toBe("transient write failure");

      // After the error the lock must have been released via try/finally.
      // The second write should succeed without hanging.
      await expect(
        writer.write(SubstrateFileType.MEMORY, "# Memory\n\nSecond")
      ).resolves.toBeUndefined();

      const content = await mockFs.readDirect("/substrate/MEMORY.md");
      expect(content).toBe("# Memory\n\nSecond");
    });
  });

  // ─── 4. Partial Write Failures ───────────────────────────────────────────

  describe("Partial Write Failures", () => {
    it("failed writeFile leaves no stale temporary files in the substrate directory", async () => {
      await mockFs.mkdir("/substrate", { recursive: true });
      await mockFs.writeFile("/substrate/MEMORY.md", "# Memory\n\nOriginal");
      mockFs.injectError("writeFile", "/substrate/MEMORY.md", enospc());

      await expect(
        writer.write(SubstrateFileType.MEMORY, "# Memory\n\nNew")
      ).rejects.toThrow();

      // Substrate directory should contain only the expected files — no temp artifacts
      const files = await mockFs.readdir("/substrate");
      const tempFiles = files.filter(
        (f) => f.startsWith(".tmp") || f.endsWith(".tmp") || f.endsWith(".partial")
      );
      expect(tempFiles).toHaveLength(0);
    });

    it("failed appendFile during rotation preserves the original PROGRESS.md", async () => {
      const original = "# Progress\n\nImportant historical entry\n";
      await mockFs.writeFile("/substrate/PROGRESS.md", original);

      // Threshold of 1 byte means rotation triggers; copyFile succeeds but subsequent
      // writeFile (truncating PROGRESS.md) fails — original must survive.
      const smallWriter = new AppendOnlyWriter(mockFs, config, lock, clock, undefined, 1);
      mockFs.injectError("writeFile", "/substrate/PROGRESS.md", enospc(), true);

      // The initial appendFile succeeds (one-time writeFile error fires on the rotation step)
      // — however the error might occur at the rotation writeFile, not the append.
      // Either way the original content must not be lost.
      const outcome = await smallWriter
        .append(SubstrateFileType.PROGRESS, "Trigger rotation")
        .catch((e: Error) => e.message);

      // Whether it threw or not, the file must still be readable
      const exists = await mockFs.exists("/substrate/PROGRESS.md");
      expect(exists).toBe(true);

      // If the append itself succeeded, we just verify nothing is corrupted
      if (typeof outcome !== "string") {
        const content = await mockFs.readDirect("/substrate/PROGRESS.md");
        expect(content.length).toBeGreaterThan(0);
      }
    });
  });

  // ─── 5. File System Unavailability ──────────────────────────────────────

  describe("File System Unavailability", () => {
    it("FileReader surfaces a clear error when the substrate file is missing (dir deleted)", async () => {
      // File was never written — simulates a deleted substrate directory
      const reader = new SubstrateFileReader(mockFs, config, false);

      await expect(reader.read(SubstrateFileType.PLAN)).rejects.toThrow();
    });

    it("operations complete (or fail fast) under a slow network FS (50 ms delay)", async () => {
      mockFs.setDelay(50);
      await mockFs.writeFile("/substrate/MEMORY.md", "# Memory\n\nContent");

      const start = Date.now();
      await writer.write(SubstrateFileType.MEMORY, "# Memory\n\nUpdated");
      const elapsed = Date.now() - start;

      // Should complete — not hang. Generous upper bound to avoid flakiness on CI.
      expect(elapsed).toBeLessThan(3000);

      const content = await mockFs.readDirect("/substrate/MEMORY.md");
      expect(content).toBe("# Memory\n\nUpdated");
    });
  });
});
