import { ConversationArchiver } from "../../src/conversation/ConversationArchiver";
import { NodeFileSystem } from "../../src/substrate/abstractions/NodeFileSystem";
import { SystemClock } from "../../src/substrate/abstractions/SystemClock";
import * as path from "node:path";
import * as fs from "node:fs";

describe("ConversationArchiver Integration Test", () => {
  const testDir = "/tmp/integration-test-substrate";
  const archiveDir = path.join(testDir, "archive", "conversation");

  beforeAll(async () => {
    // Clean up from previous runs
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  afterAll(() => {
    // Clean up
    if (fs.existsSync(testDir)) {
      fs.rmSync(testDir, { recursive: true });
    }
  });

  it("should create archive directory and files on disk", async () => {
    const content = [
      "# Conversation Log",
      "",
      "[2025-01-15T08:00:00.000Z] [USER] Old message 1",
      "[2025-01-15T08:05:00.000Z] [EGO] Old response 1",
      "[2025-01-15T08:10:00.000Z] [USER] Old message 2",
      "[2025-01-15T10:00:00.000Z] [USER] Recent message 1",
      "[2025-01-15T10:05:00.000Z] [EGO] Recent response 1",
    ].join("\n");

    const fileSystem = new NodeFileSystem();
    const clock = new SystemClock();
    const archiver = new ConversationArchiver(fileSystem, clock, testDir);

    // Archive, keeping last 2 lines
    const result = await archiver.archive(content, 2);

    expect(result.linesArchived).toBe(3);
    expect(result.archivedPath).toBeDefined();

    // Verify archive directory exists
    expect(fs.existsSync(archiveDir)).toBe(true);

    // Verify archive file exists
    expect(fs.existsSync(result.archivedPath!)).toBe(true);

    // Verify archive content
    const archiveContent = fs.readFileSync(result.archivedPath!, "utf8");
    expect(archiveContent).toContain("# Archived Conversation");
    expect(archiveContent).toContain("Lines archived: 3");
    expect(archiveContent).toContain("[2025-01-15T08:00:00.000Z] [USER] Old message 1");
    expect(archiveContent).toContain("[2025-01-15T08:05:00.000Z] [EGO] Old response 1");
    expect(archiveContent).toContain("[2025-01-15T08:10:00.000Z] [USER] Old message 2");

    // Verify remaining content
    expect(result.remainingContent).toContain("# Conversation Log");
    expect(result.remainingContent).toContain("## Recent Conversation");
    expect(result.remainingContent).toContain("[2025-01-15T10:00:00.000Z] [USER] Recent message 1");
    expect(result.remainingContent).toContain("[2025-01-15T10:05:00.000Z] [EGO] Recent response 1");
    expect(result.remainingContent).not.toContain("[2025-01-15T08:00:00.000Z] [USER] Old message 1");
  });

  it("should create multiple archive files over time", async () => {
    const content1 = [
      "# Conversation",
      "[2025-01-15T08:00:00.000Z] [USER] Message 1",
      "[2025-01-15T08:05:00.000Z] [USER] Message 2",
      "[2025-01-15T08:10:00.000Z] [USER] Message 3",
    ].join("\n");

    const fileSystem = new NodeFileSystem();
    const clock = new SystemClock();
    const archiver = new ConversationArchiver(fileSystem, clock, testDir);

    // First archive
    const result1 = await archiver.archive(content1, 1);
    expect(result1.linesArchived).toBe(2);

    // Second archive (simulate later time)
    await new Promise((resolve) => setTimeout(resolve, 10)); // Small delay to ensure different timestamp
    const content2 = [
      "# Conversation",
      "[2025-01-15T09:00:00.000Z] [USER] Message 4",
      "[2025-01-15T09:05:00.000Z] [USER] Message 5",
      "[2025-01-15T09:10:00.000Z] [USER] Message 6",
    ].join("\n");

    const result2 = await archiver.archive(content2, 1);
    expect(result2.linesArchived).toBe(2);

    // Verify both archives exist
    expect(fs.existsSync(result1.archivedPath!)).toBe(true);
    expect(fs.existsSync(result2.archivedPath!)).toBe(true);

    // Verify they have different filenames
    expect(result1.archivedPath).not.toBe(result2.archivedPath);

    // Verify archive directory has 2 files
    const files = fs.readdirSync(archiveDir);
    expect(files.length).toBeGreaterThanOrEqual(2);
  });
});
