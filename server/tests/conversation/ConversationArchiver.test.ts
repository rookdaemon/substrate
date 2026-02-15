import { ConversationArchiver } from "../../src/conversation/ConversationArchiver";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import * as path from "node:path";

describe("ConversationArchiver", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let archiver: ConversationArchiver;
  const substratePath = "/test/substrate";

  beforeEach(() => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-01-15T10:30:00.000Z"));
    archiver = new ConversationArchiver(fs, clock, substratePath);
  });

  describe("archive", () => {
    it("should archive old content and keep recent lines", async () => {
      const content = [
        "# Conversation Log",
        "",
        "[2025-01-15T08:00:00.000Z] [USER] First message",
        "[2025-01-15T08:05:00.000Z] [EGO] First response",
        "[2025-01-15T08:10:00.000Z] [USER] Second message",
        "[2025-01-15T08:15:00.000Z] [EGO] Second response",
        "[2025-01-15T10:00:00.000Z] [USER] Recent message",
        "[2025-01-15T10:05:00.000Z] [EGO] Recent response",
      ].join('\n');

      const result = await archiver.archive(content, 4);

      // Should have archived 2 lines
      expect(result.linesArchived).toBe(2);
      expect(result.archivedPath).toBeDefined();

      // Check archived file was created
      const archiveDir = path.join(substratePath, 'archive', 'conversation');
      expect(await fs.exists(archiveDir)).toBe(true);

      // Check archived file content
      const archivedContent = await fs.readFile(result.archivedPath!);
      expect(archivedContent).toContain("# Archived Conversation");
      expect(archivedContent).toContain("Lines archived: 2");
      expect(archivedContent).toContain("[2025-01-15T08:00:00.000Z] [USER] First message");
      expect(archivedContent).toContain("[2025-01-15T08:05:00.000Z] [EGO] First response");

      // Check remaining content
      expect(result.remainingContent).toContain("# Conversation Log");
      expect(result.remainingContent).toContain("## Recent Conversation");
      expect(result.remainingContent).toContain("conversation-2025-01-15T10-30-00-000Z.md");
      expect(result.remainingContent).toContain("[2025-01-15T08:10:00.000Z] [USER] Second message");
      expect(result.remainingContent).toContain("[2025-01-15T10:05:00.000Z] [EGO] Recent response");
      
      // Should not contain archived lines
      expect(result.remainingContent).not.toContain("[2025-01-15T08:00:00.000Z] [USER] First message");
    });

    it("should handle content with no headers", async () => {
      const content = [
        "[2025-01-15T08:00:00.000Z] [USER] First message",
        "[2025-01-15T08:05:00.000Z] [EGO] First response",
        "[2025-01-15T10:00:00.000Z] [USER] Recent message",
      ].join('\n');

      const result = await archiver.archive(content, 2);

      expect(result.linesArchived).toBe(1);
      expect(result.remainingContent).toContain("## Recent Conversation");
      expect(result.remainingContent).toContain("[2025-01-15T08:05:00.000Z] [EGO] First response");
      expect(result.remainingContent).toContain("[2025-01-15T10:00:00.000Z] [USER] Recent message");
    });

    it("should not archive if content lines are less than linesToKeep", async () => {
      const content = [
        "# Conversation Log",
        "",
        "[2025-01-15T10:00:00.000Z] [USER] Recent message",
        "[2025-01-15T10:05:00.000Z] [EGO] Recent response",
      ].join('\n');

      const result = await archiver.archive(content, 10);

      expect(result.linesArchived).toBe(0);
      expect(result.archivedPath).toBeUndefined();
      expect(result.remainingContent).toBe(content);
    });

    it("should create archive directory if it doesn't exist", async () => {
      const content = [
        "[2025-01-15T08:00:00.000Z] [USER] Old message",
        "[2025-01-15T10:00:00.000Z] [USER] Recent message",
      ].join('\n');

      const archiveDir = path.join(substratePath, 'archive', 'conversation');
      expect(await fs.exists(archiveDir)).toBe(false);

      await archiver.archive(content, 1);

      expect(await fs.exists(archiveDir)).toBe(true);
    });

    it("should use date-stamped filename format", async () => {
      const content = [
        "[2025-01-15T08:00:00.000Z] [USER] Old message",
        "[2025-01-15T10:00:00.000Z] [USER] Recent message",
      ].join('\n');

      const result = await archiver.archive(content, 1);

      expect(result.archivedPath).toBeDefined();
      expect(result.archivedPath).toContain("conversation-2025-01-15T10-30-00-000Z.md");
    });

    it("should preserve multiple headers", async () => {
      const content = [
        "# Conversation Log",
        "## Session Started",
        "",
        "[2025-01-15T08:00:00.000Z] [USER] Old message",
        "[2025-01-15T10:00:00.000Z] [USER] Recent message",
      ].join('\n');

      const result = await archiver.archive(content, 1);

      expect(result.remainingContent).toContain("# Conversation Log");
      expect(result.remainingContent).toContain("## Session Started");
    });

    it("should handle empty content", async () => {
      const content = "";

      const result = await archiver.archive(content, 10);

      expect(result.linesArchived).toBe(0);
      expect(result.archivedPath).toBeUndefined();
    });
  });
});
