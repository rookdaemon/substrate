import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateFileType } from "../../../src/substrate/types";

describe("AppendOnlyWriter", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let config: SubstrateConfig;
  let lock: FileLock;
  let writer: AppendOnlyWriter;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:30:00Z"));
    config = new SubstrateConfig("/substrate");
    lock = new FileLock();
    writer = new AppendOnlyWriter(fs, config, lock, clock);

    // Pre-create the append-mode files
    await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
    await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
  });

  it("appends a timestamped entry to PROGRESS", async () => {
    await writer.append(SubstrateFileType.PROGRESS, "First entry");
    const content = await fs.readFile("/substrate/PROGRESS.md");
    expect(content).toContain("[2025-06-15T10:30:00.000Z]");
    expect(content).toContain("First entry");
  });

  it("appends a timestamped entry to CONVERSATION", async () => {
    await writer.append(SubstrateFileType.CONVERSATION, "Hello world");
    const content = await fs.readFile("/substrate/CONVERSATION.md");
    expect(content).toContain("[2025-06-15T10:30:00.000Z]");
    expect(content).toContain("Hello world");
  });

  it("appends multiple entries in order", async () => {
    await writer.append(SubstrateFileType.PROGRESS, "Entry 1");
    clock.setNow(new Date("2025-06-15T10:31:00Z"));
    await writer.append(SubstrateFileType.PROGRESS, "Entry 2");

    const content = await fs.readFile("/substrate/PROGRESS.md");
    const idx1 = content.indexOf("Entry 1");
    const idx2 = content.indexOf("Entry 2");
    expect(idx1).toBeLessThan(idx2);
    expect(content).toContain("[2025-06-15T10:30:00.000Z]");
    expect(content).toContain("[2025-06-15T10:31:00.000Z]");
  });

  it("rejects OVERWRITE-mode file types", async () => {
    await expect(
      writer.append(SubstrateFileType.PLAN, "Some text")
    ).rejects.toThrow("Cannot use AppendOnlyWriter for OVERWRITE-mode");
  });

  it("rejects MEMORY (OVERWRITE-mode)", async () => {
    await expect(
      writer.append(SubstrateFileType.MEMORY, "Some text")
    ).rejects.toThrow("Cannot use AppendOnlyWriter for OVERWRITE-mode");
  });

  describe("secret detection", () => {
    it("redacts entries containing API keys instead of rejecting", async () => {
      const entry = '[SUBCONSCIOUS] Progress update: api_key: "abcdef1234567890abcdef1234567890abcdef12"';

      await writer.append(SubstrateFileType.PROGRESS, entry);

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("abcdef1234567890abcdef1234567890abcdef12");
    });

    it("redacts entries containing tokens", async () => {
      const entry = '[ID] Generated goal with auth_token: "my-secret-token-12345678901234567890"';

      await writer.append(SubstrateFileType.PROGRESS, entry);

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("my-secret-token-12345678901234567890");
    });

    it("redacts entries containing AWS credentials", async () => {
      const entry = "[EGO] Task result: AWS_ACCESS_KEY_ID=AKIAIOSFODNN7EXAMPLE";

      await writer.append(SubstrateFileType.PROGRESS, entry);

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("AKIAIOSFODNN7EXAMPLE");
    });

    it("redacts entries containing private keys", async () => {
      const entry = "[SUPEREGO] Audit finding: -----BEGIN PRIVATE KEY-----";

      await writer.append(SubstrateFileType.PROGRESS, entry);

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("BEGIN PRIVATE KEY");
    });

    it("redacts entries containing database connection strings", async () => {
      const entry = "[SUBCONSCIOUS] Database connected: postgres://user:password@localhost:5432/db";

      await writer.append(SubstrateFileType.PROGRESS, entry);

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("[REDACTED]");
      expect(content).not.toContain("postgres://user:password");
    });

    it("accepts entries without secrets unchanged", async () => {
      const entry = "[SUBCONSCIOUS] I learned about API key security today. Always use environment variables!";

      await writer.append(SubstrateFileType.PROGRESS, entry);

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain(entry);
    });
  });

  describe("PROGRESS rotation", () => {
    let smallWriter: AppendOnlyWriter;

    beforeEach(() => {
      // threshold of 10 bytes — triggers rotation after first non-trivial append
      smallWriter = new AppendOnlyWriter(fs, config, lock, clock, undefined, 10);
    });

    it("rotates PROGRESS.md when size exceeds threshold", async () => {
      await smallWriter.append(SubstrateFileType.PROGRESS, "This entry is definitely longer than ten bytes");

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("# Progress Log");
      expect(content).toContain("# Rotated:");
    });

    it("archive file contains the original content", async () => {
      await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\nOriginal content\n");
      await smallWriter.append(SubstrateFileType.PROGRESS, "New entry to trigger rotation");

      const archiveDir = "/substrate/progress";
      const entries = await fs.readdir(archiveDir);
      expect(entries.length).toBe(1);

      const archiveContent = await fs.readFile(`${archiveDir}/${entries[0]}`);
      expect(archiveContent).toContain("Original content");
    });

    it("archive file name contains the ISO timestamp with colons replaced by hyphens", async () => {
      await smallWriter.append(SubstrateFileType.PROGRESS, "Entry to trigger rotation");

      const archiveDir = "/substrate/progress";
      const entries = await fs.readdir(archiveDir);
      expect(entries.length).toBe(1);
      expect(entries[0]).toBe("PROGRESS-2025-06-15T10-30-00Z.md");
    });

    it("fresh PROGRESS.md contains archive reference header", async () => {
      await smallWriter.append(SubstrateFileType.PROGRESS, "Entry to trigger rotation");

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).toContain("progress/PROGRESS-2025-06-15T10-30-00Z.md");
    });

    it("does NOT rotate when size is below threshold", async () => {
      const largeWriter = new AppendOnlyWriter(fs, config, lock, clock, undefined, 1024 * 1024);
      await largeWriter.append(SubstrateFileType.PROGRESS, "Small entry");

      const content = await fs.readFile("/substrate/PROGRESS.md");
      expect(content).not.toContain("# Rotated:");
      expect(content).toContain("Small entry");
    });

    it("does NOT rotate CONVERSATION even when it exceeds threshold", async () => {
      await smallWriter.append(SubstrateFileType.CONVERSATION, "This is also longer than ten bytes and should not rotate");

      const exists = await fs.exists("/substrate/progress");
      expect(exists).toBe(false);

      const content = await fs.readFile("/substrate/CONVERSATION.md");
      expect(content).not.toContain("# Rotated:");
      expect(content).toContain("This is also longer than ten bytes");
    });

    it("two consecutive over-threshold appends create only one archive per append", async () => {
      // First append — creates first archive
      await smallWriter.append(SubstrateFileType.PROGRESS, "First over-threshold entry");
      clock.setNow(new Date("2025-06-15T10:31:00Z"));
      // Second append — fresh file is small, then grows and creates second archive
      await smallWriter.append(SubstrateFileType.PROGRESS, "Second over-threshold entry");

      const archiveDir = "/substrate/progress";
      const entries = await fs.readdir(archiveDir);
      // Each append that triggers rotation creates exactly one archive
      expect(entries.length).toBe(2);
      expect(entries).toContain("PROGRESS-2025-06-15T10-30-00Z.md");
      expect(entries).toContain("PROGRESS-2025-06-15T10-31-00Z.md");
    });
  });
});
