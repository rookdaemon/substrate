import { SubstrateFileWriter } from "../../../src/substrate/io/FileWriter";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../../../src/substrate/config";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateFileType } from "../../../src/substrate/types";
import { InMemoryLogger } from "../../../src/logging";
import * as SecretDetector from "../../../src/substrate/validation/SecretDetector";

describe("SubstrateFileWriter", () => {
  let fs: InMemoryFileSystem;
  let config: SubstrateConfig;
  let lock: FileLock;
  let writer: SubstrateFileWriter;

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    config = new SubstrateConfig("/substrate");
    lock = new FileLock();
    writer = new SubstrateFileWriter(fs, config, lock);
  });

  it("writes valid content to a file", async () => {
    await writer.write(SubstrateFileType.MEMORY, "# Memory\n\nSome notes");
    const content = await fs.readFile("/substrate/MEMORY.md");
    expect(content).toBe("# Memory\n\nSome notes");
  });

  it("rejects invalid content", async () => {
    await expect(
      writer.write(SubstrateFileType.MEMORY, "")
    ).rejects.toThrow("Validation failed");
  });

  it("rejects content without heading", async () => {
    await expect(
      writer.write(SubstrateFileType.MEMORY, "No heading")
    ).rejects.toThrow("Validation failed");
  });

  it("rejects writes to APPEND-mode files", async () => {
    await expect(
      writer.write(SubstrateFileType.PROGRESS, "# Progress\n\nEntry")
    ).rejects.toThrow("Cannot use FileWriter for APPEND-mode");
  });

  it("rejects writes to CONVERSATION (APPEND-mode)", async () => {
    await expect(
      writer.write(SubstrateFileType.CONVERSATION, "# Conversation\n\nMsg")
    ).rejects.toThrow("Cannot use FileWriter for APPEND-mode");
  });

  it("rejects writes to OPERATING_CONTEXT (APPEND-mode)", async () => {
    await expect(
      writer.write(SubstrateFileType.OPERATING_CONTEXT, "# Operating Context\n\nMsg")
    ).rejects.toThrow("Cannot use FileWriter for APPEND-mode");
  });

  it("serializes writes to the same file type via lock", async () => {
    const order: number[] = [];

    const p1 = writer
      .write(SubstrateFileType.MEMORY, "# Memory\n\nFirst")
      .then(() => order.push(1));
    const p2 = writer
      .write(SubstrateFileType.MEMORY, "# Memory\n\nSecond")
      .then(() => order.push(2));

    await Promise.all([p1, p2]);

    expect(order).toEqual([1, 2]);
    // Second write wins (last writer)
    const content = await fs.readFile("/substrate/MEMORY.md");
    expect(content).toBe("# Memory\n\nSecond");
  });

  describe("post-write secret detection", () => {
    const SECRET_CONTENT = '# Memory\n\napi_key: "abcdef1234567890abcdef1234567890abcdef12"';
    const CLEAN_CONTENT = "# Memory\n\nSome safe notes";

    it("emits a high-severity error log when secrets are detected in written content", async () => {
      const logger = new InMemoryLogger();
      const writerWithLogger = new SubstrateFileWriter(fs, config, lock, undefined, logger);

      await writerWithLogger.write(SubstrateFileType.MEMORY, SECRET_CONTENT);

      const errors = logger.getErrorEntries();
      expect(errors.length).toBeGreaterThan(0);
      expect(errors[0]).toContain("[SECURITY]");
      expect(errors[0]).toContain("Generic API Key");
      expect(errors[0]).not.toMatch(/abcdef1234567890/);
    });

    it("does not emit an error log when content contains no secrets", async () => {
      const logger = new InMemoryLogger();
      const writerWithLogger = new SubstrateFileWriter(fs, config, lock, undefined, logger);

      await writerWithLogger.write(SubstrateFileType.MEMORY, CLEAN_CONTENT);

      expect(logger.getErrorEntries()).toHaveLength(0);
    });

    it("continues the write and logs a warning when SecretDetector.scan() throws", async () => {
      const logger = new InMemoryLogger();
      const writerWithLogger = new SubstrateFileWriter(fs, config, lock, undefined, logger);

      const spy = jest.spyOn(SecretDetector, "scan").mockImplementation(() => {
        throw new Error("scan internal error");
      });

      try {
        await writerWithLogger.write(SubstrateFileType.MEMORY, CLEAN_CONTENT);
      } finally {
        spy.mockRestore();
      }

      // Write must have succeeded
      const written = await fs.readFile("/substrate/MEMORY.md");
      expect(written).toBe(CLEAN_CONTENT);

      // Warning must have been logged
      const warns = logger.getWarnEntries();
      expect(warns.length).toBeGreaterThan(0);
      expect(warns[0]).toContain("secret scan failed");

      // No error emitted (scan threw before we could determine secrets)
      expect(logger.getErrorEntries()).toHaveLength(0);
    });
  });
});
