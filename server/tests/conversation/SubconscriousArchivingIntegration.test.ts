import { Subconscious } from "../../src/agents/roles/Subconscious";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../src/substrate/config";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { TaskClassifier } from "../../src/agents/TaskClassifier";
import { ConversationManager, ConversationArchiveConfig } from "../../src/conversation/ConversationManager";
import { ConversationArchiver } from "../../src/conversation/ConversationArchiver";
import { IConversationCompactor } from "../../src/conversation/IConversationCompactor";

// Mock compactor for ConversationManager
class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

describe("Subconscious archiving integration", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let launcher: InMemorySessionLauncher;
  let subconscious: Subconscious;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
    launcher = new InMemorySessionLauncher();
    const config = new SubstrateConfig("/substrate");
    const reader = new SubstrateFileReader(fs, config);
    const lock = new FileLock();
    const writer = new SubstrateFileWriter(fs, config, lock);
    const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker);
    const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
    const compactor = new MockCompactor();
    
    // Create archiver with real implementation
    const archiver = new ConversationArchiver(fs, clock, "/substrate");
    const archiveConfig: ConversationArchiveConfig = {
      enabled: true,
      linesToKeep: 5,
      sizeThreshold: 10, // Low threshold to trigger easily
      timeThresholdMs: undefined,
    };

    const conversationManager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock,
      archiver, archiveConfig
    );

    subconscious = new Subconscious(
      reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier, "/workspace"
    );

    await fs.mkdir("/substrate", { recursive: true });
    await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nBuild it\n\n## Tasks\n- [ ] Task A");
    await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\nSome memories");
    await fs.writeFile("/substrate/HABITS.md", "# Habits\n\nSome habits");
    await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\nSome skills");
    await fs.writeFile("/substrate/VALUES.md", "# Values\n\nBe good");
    await fs.writeFile("/substrate/ID.md", "# Id\n\nCore identity");
    await fs.writeFile("/substrate/SECURITY.md", "# Security\n\nStay safe");
    await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\nOur mission");
    await fs.writeFile("/substrate/SUPEREGO.md", "# Superego\n\nRules here");
    await fs.writeFile("/substrate/CLAUDE.md", "# Claude\n\nConfig here");
    await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
    await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");
  });

  it("triggers archiving when size threshold is exceeded via Subconscious writes", async () => {
    // Write enough entries to exceed the threshold (10 lines)
    for (let i = 0; i < 12; i++) {
      await subconscious.logConversation(`Entry ${i}`);
    }

    // Check that archive directory was created
    const archiveDir = "/substrate/archive/conversation";
    const stat = await fs.stat(archiveDir);
    expect(stat.isDirectory).toBe(true);

    // Check that an archive file was created
    const files = await fs.readdir(archiveDir);
    expect(files.length).toBeGreaterThan(0);
    expect(files[0]).toMatch(/^conversation-\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z\.md$/);

    // Check that CONVERSATION.md was trimmed
    // After archiving at 10 lines (keeping 5), we write 2 more, so we expect 7 lines
    const conversationContent = await fs.readFile("/substrate/CONVERSATION.md");
    const lines = conversationContent.split('\n').filter(l => l.trim().length > 0 && !l.startsWith('#'));
    expect(lines.length).toBeLessThan(12); // Should be less than total written
    expect(lines.length).toBeGreaterThanOrEqual(5); // Should have at least linesToKeep
  });

  it("archived file contains old conversation entries", async () => {
    // Write entries
    for (let i = 0; i < 12; i++) {
      await subconscious.logConversation(`Entry ${i}`);
    }

    // Read the archived file
    const archiveDir = "/substrate/archive/conversation";
    const files = await fs.readdir(archiveDir);
    const archivedContent = await fs.readFile(`${archiveDir}/${files[0]}`);

    // Old entries should be in the archive
    expect(archivedContent).toContain("Entry 0");
    expect(archivedContent).toContain("Entry 1");
    expect(archivedContent).toContain("Entry 2");
  });

  it("retains recent entries in CONVERSATION.md after archiving", async () => {
    // Write entries
    for (let i = 0; i < 12; i++) {
      await subconscious.logConversation(`Entry ${i}`);
    }

    // Read CONVERSATION.md
    const conversationContent = await fs.readFile("/substrate/CONVERSATION.md");

    // Recent entries should still be in CONVERSATION.md
    expect(conversationContent).toContain("Entry 11");
    expect(conversationContent).toContain("Entry 10");
    expect(conversationContent).toContain("Entry 9");
    expect(conversationContent).toContain("Entry 8");
    expect(conversationContent).toContain("Entry 7");
  });
});
