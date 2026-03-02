/**
 * Substrate Persistence Integration Tests
 *
 * Uses real NodeFileSystem with /tmp directories to verify persistence behaviour
 * under concurrent access, rotation, error conditions, and cache invalidation.
 */

import * as fsPromises from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { NodeFileSystem } from "../../src/substrate/abstractions/NodeFileSystem";
import { SubstrateConfig } from "../../src/substrate/config";
import { FileLock } from "../../src/substrate/io/FileLock";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { SubstrateFileType } from "../../src/substrate/types";
import { SystemClock } from "../../src/substrate/abstractions/SystemClock";

const execFileAsync = promisify(execFile);

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmpDir(): Promise<string> {
  return fsPromises.mkdtemp(path.join(os.tmpdir(), "substrate-int-"));
}

async function removeTmpDir(dir: string): Promise<void> {
  await fsPromises.rm(dir, { recursive: true, force: true });
}

/** Seed the minimum files that SubstrateConfig / Writers expect to exist. */
async function seedSubstrateDir(dir: string): Promise<void> {
  await fsPromises.mkdir(dir, { recursive: true });
  await fsPromises.writeFile(path.join(dir, "MEMORY.md"), "# Memory\n\nInitial content\n", "utf-8");
  await fsPromises.writeFile(path.join(dir, "PLAN.md"), "# Plan\n\nInitial plan\n", "utf-8");
  await fsPromises.writeFile(path.join(dir, "PROGRESS.md"), "# Progress\n\n", "utf-8");
  await fsPromises.writeFile(path.join(dir, "CONVERSATION.md"), "# Conversation\n\n", "utf-8");
}

function buildDeps(basePath: string, progressMaxBytes?: number) {
  const fs = new NodeFileSystem();
  const config = new SubstrateConfig(basePath);
  const lock = new FileLock();
  const clock = new SystemClock();
  const reader = new SubstrateFileReader(fs, config);
  const writer = new SubstrateFileWriter(fs, config, lock, reader);
  const appendWriter = new AppendOnlyWriter(fs, config, lock, clock, reader, progressMaxBytes);
  return { fs, config, lock, clock, reader, writer, appendWriter };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("Substrate Persistence Integration", () => {
  let tmpDir: string;

  beforeEach(async () => {
    tmpDir = await makeTmpDir();
    await seedSubstrateDir(tmpDir);
  });

  afterEach(async () => {
    await removeTmpDir(tmpDir);
  });

  // ── 1. Atomic write verification ─────────────────────────────────────────

  it("100KB write — concurrent reads never see partial content", async () => {
    jest.setTimeout(15000);
    const { writer, fs, config } = buildDeps(tmpDir);

    // Build a 100 KB payload that passes validation (starts with heading).
    const padding = "x".repeat(1024);
    const line = `${padding}\n`;
    const body = line.repeat(100); // ~102 KB total with heading
    const bigContent = `# Memory\n\n${body}`;
    expect(Buffer.byteLength(bigContent, "utf-8")).toBeGreaterThanOrEqual(100 * 1024);

    const filePath = config.getFilePath(SubstrateFileType.MEMORY);

    // Launch the large write.
    const writePromise = writer.write(SubstrateFileType.MEMORY, bigContent);

    // Concurrently read 20 times while the write may be in progress.
    const reads = Array.from({ length: 20 }, () =>
      fs.readFile(filePath).catch(() => null)
    );

    await writePromise;
    const results = await Promise.all(reads);

    const initialContent = "# Memory\n\nInitial content\n";

    for (const result of results) {
      if (result === null) {
        // A transient read error is acceptable (race before write starts)
        continue;
      }
      // Each successful read must return either the old or the new complete content.
      const isOld = result === initialContent;
      const isNew = result === bigContent;
      expect(isOld || isNew).toBe(true);
    }

    // After the write settles, the file must contain the full new content.
    const final = await fs.readFile(filePath);
    expect(final).toBe(bigContent);
  });

  // ── 2. Concurrent write serialization ────────────────────────────────────

  it("10 concurrent writes via FileLock complete without corruption", async () => {
    jest.setTimeout(10000);
    const { writer, fs, config } = buildDeps(tmpDir);

    const completed: number[] = [];

    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        writer
          .write(SubstrateFileType.MEMORY, `# Memory\n\nWrite ${i}`)
          .then(() => completed.push(i))
      )
    );

    // All 10 writes must have completed (lock must not deadlock).
    expect(completed).toHaveLength(10);
    const allIndices = new Set(completed);
    for (let i = 0; i < 10; i++) {
      expect(allIndices.has(i)).toBe(true);
    }

    // The final content must be a complete, valid write — not a corrupted mix.
    const final = await fs.readFile(config.getFilePath(SubstrateFileType.MEMORY));
    expect(final).toMatch(/^# Memory\n\nWrite \d+$/);
  });

  // ── 3. Append concurrency ─────────────────────────────────────────────────

  it("50 concurrent appends — all entries preserved, no duplicates", async () => {
    jest.setTimeout(15000);
    const { appendWriter, fs, config } = buildDeps(tmpDir);

    const entries = Array.from({ length: 50 }, (_, i) => `ConcurrentEntry-${i}`);

    await Promise.all(entries.map((e) => appendWriter.append(SubstrateFileType.PROGRESS, e)));

    const content = await fs.readFile(config.getFilePath(SubstrateFileType.PROGRESS));

    // Every entry must appear exactly once (use \b word-boundary to avoid
    // "ConcurrentEntry-1" matching "ConcurrentEntry-10").
    for (const entry of entries) {
      const escapedEntry = entry.replace(/[-]/g, "\\$&");
      const occurrences = (content.match(new RegExp(`${escapedEntry}\\b`, "g")) ?? []).length;
      expect(occurrences).toBe(1);
    }
  });

  // ── 4. PROGRESS.md rotation under load ───────────────────────────────────

  it("PROGRESS.md rotates when threshold is exceeded and backup is created", async () => {
    jest.setTimeout(10000);
    // Use a very small threshold (1 byte) to force rotation on any append.
    const { appendWriter, fs, config } = buildDeps(tmpDir, 1);

    await appendWriter.append(SubstrateFileType.PROGRESS, "Entry that triggers rotation");

    // The live PROGRESS.md must have been reset.
    const liveContent = await fs.readFile(config.getFilePath(SubstrateFileType.PROGRESS));
    expect(liveContent).toContain("# Progress Log");
    expect(liveContent).toContain("# Rotated:");

    // The archive directory must contain exactly one backup.
    const archiveDir = path.join(tmpDir, "progress");
    const archiveFiles = await fs.readdir(archiveDir);
    expect(archiveFiles).toHaveLength(1);
    expect(archiveFiles[0]).toMatch(/^PROGRESS-.*\.md$/);

    // The backup must contain the original header.
    const backupContent = await fs.readFile(path.join(archiveDir, archiveFiles[0]));
    expect(backupContent).toContain("# Progress");
  });

  // ── 5. File system error recovery (EACCES) ───────────────────────────────

  it("write to read-only directory surfaces EACCES", async () => {
    jest.setTimeout(10000);

    // Create a separate directory that we make read-only.
    const readOnlyDir = await makeTmpDir();
    try {
      // Make it read-only so writes will fail.
      await fsPromises.chmod(readOnlyDir, 0o444);

      const { writer } = buildDeps(readOnlyDir);

      await expect(
        writer.write(SubstrateFileType.MEMORY, "# Memory\n\nShould fail")
      ).rejects.toThrow(/EACCES|permission denied/i);
    } finally {
      // Restore permissions so afterEach can delete it.
      await fsPromises.chmod(readOnlyDir, 0o755).catch(() => undefined);
      await removeTmpDir(readOnlyDir);
    }
  });

  // ── 6. GitVersionControl integration ─────────────────────────────────────

  it("write → git commit → file is tracked in repository", async () => {
    jest.setTimeout(15000);

    // Skip if git is not available.
    const gitAvailable = await execFileAsync("git", ["--version"])
      .then(() => true)
      .catch(() => false);

    if (!gitAvailable) {
      return;
    }

    const gitDir = await makeTmpDir();
    try {
      // Initialise a git repository.
      await execFileAsync("git", ["init", gitDir]);
      await execFileAsync("git", ["config", "user.email", "test@example.com"], { cwd: gitDir });
      await execFileAsync("git", ["config", "user.name", "Test User"], { cwd: gitDir });

      await seedSubstrateDir(gitDir);

      const { writer } = buildDeps(gitDir);
      await writer.write(SubstrateFileType.MEMORY, "# Memory\n\nGit tracked content");

      // Stage and commit the file.
      await execFileAsync("git", ["add", "MEMORY.md"], { cwd: gitDir });
      await execFileAsync(
        "git",
        ["commit", "-m", "Add substrate MEMORY.md", "--allow-empty-message"],
        { cwd: gitDir }
      );

      // Verify the file is tracked (appears in the last commit).
      const { stdout } = await execFileAsync("git", ["show", "--name-only", "--format=", "HEAD"], {
        cwd: gitDir,
      });
      expect(stdout.trim()).toContain("MEMORY.md");

      // Verify the committed content matches what was written.
      const { stdout: blob } = await execFileAsync(
        "git",
        ["show", "HEAD:MEMORY.md"],
        { cwd: gitDir }
      );
      expect(blob).toContain("Git tracked content");
    } finally {
      await removeTmpDir(gitDir);
    }
  });

  // ── 7. Reader cache invalidation ─────────────────────────────────────────

  it("cache is invalidated after write — second read returns V2 content", async () => {
    jest.setTimeout(10000);
    const { reader, writer } = buildDeps(tmpDir);

    const v1Content = "# Memory\n\nVersion 1 content";
    const v2Content = "# Memory\n\nVersion 2 content";

    // Write V1 and read it — populates the cache.
    await writer.write(SubstrateFileType.MEMORY, v1Content);
    const read1 = await reader.read(SubstrateFileType.MEMORY);
    expect(read1.rawMarkdown).toBe(v1Content);

    // Write V2 — writer invalidates the cache via reader.invalidate().
    await writer.write(SubstrateFileType.MEMORY, v2Content);

    // The next read must return V2, not the stale V1.
    const read2 = await reader.read(SubstrateFileType.MEMORY);
    expect(read2.rawMarkdown).toBe(v2Content);
  });

  // ── 8. Mixed read-write concurrency ──────────────────────────────────────

  it("20 reads + 5 writes concurrently — all operations succeed", async () => {
    jest.setTimeout(15000);
    const { reader, writer, appendWriter, config, fs } = buildDeps(tmpDir);

    const filePath = config.getFilePath(SubstrateFileType.MEMORY);

    // Pre-write valid initial content so reads have something to return.
    await writer.write(SubstrateFileType.MEMORY, "# Memory\n\nBaseline");

    const writes = Array.from({ length: 5 }, (_, i) =>
      writer.write(SubstrateFileType.MEMORY, `# Memory\n\nConcurrent write ${i}`)
    );

    const reads = Array.from({ length: 20 }, () =>
      reader.read(SubstrateFileType.MEMORY)
    );

    const appends = Array.from({ length: 5 }, (_, i) =>
      appendWriter.append(SubstrateFileType.PROGRESS, `Mixed-load entry ${i}`)
    );

    const results = await Promise.allSettled([...writes, ...reads, ...appends]);

    const failures = results.filter((r) => r.status === "rejected");
    expect(failures).toHaveLength(0);

    // Final state: MEMORY.md must contain valid content.
    const finalMemory = await fs.readFile(filePath);
    expect(finalMemory).toMatch(/^# Memory/);

    // All 5 progress entries must have been appended.
    const progressContent = await fs.readFile(config.getFilePath(SubstrateFileType.PROGRESS));
    for (let i = 0; i < 5; i++) {
      expect(progressContent).toContain(`Mixed-load entry ${i}`);
    }
  });
});
