import { ConversationManager, ConversationArchiveConfig } from "../../src/conversation/ConversationManager";
import { IConversationCompactor } from "../../src/conversation/IConversationCompactor";
import { IConversationArchiver } from "../../src/conversation/IConversationArchiver";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { PermissionChecker } from "../../src/agents/permissions";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../src/substrate/config";
import { FileLock } from "../../src/substrate/io/FileLock";
import { AgentRole } from "../../src/agents/types";

// Mock compactor
class MockCompactor implements IConversationCompactor {
  public compactCalls: Array<{ content: string; oneHourAgo: string }> = [];
  private response: string = "Compacted content";

  setResponse(response: string): void {
    this.response = response;
  }

  async compact(currentContent: string, oneHourAgo: string): Promise<string> {
    this.compactCalls.push({ content: currentContent, oneHourAgo });
    return this.response;
  }

  reset(): void {
    this.compactCalls = [];
  }
}

// Mock archiver
class MockArchiver implements IConversationArchiver {
  public archiveCalls: Array<{ content: string; linesToKeep: number }> = [];
  private linesArchivedResponse: number = 0;
  private archivedPathResponse?: string = "/test/substrate/archive/conversation/test.md";

  setResponse(linesArchived: number, archivedPath?: string): void {
    this.linesArchivedResponse = linesArchived;
    this.archivedPathResponse = archivedPath;
  }

  async archive(currentContent: string, linesToKeep: number): Promise<{
    archivedPath?: string;
    remainingContent: string;
    linesArchived: number;
  }> {
    this.archiveCalls.push({ content: currentContent, linesToKeep });
    
    // Simple mock: keep last N lines
    const lines = currentContent.split('\n');
    const contentLines = lines.filter(l => l.trim().length > 0 && !l.startsWith('#'));
    const remaining = contentLines.slice(-linesToKeep).join('\n');
    
    return {
      archivedPath: this.linesArchivedResponse > 0 ? this.archivedPathResponse : undefined,
      remainingContent: remaining,
      linesArchived: this.linesArchivedResponse,
    };
  }

  reset(): void {
    this.archiveCalls = [];
  }
}

describe("ConversationManager", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let config: SubstrateConfig;
  let reader: SubstrateFileReader;
  let appendWriter: AppendOnlyWriter;
  let checker: PermissionChecker;
  let compactor: MockCompactor;
  let manager: ConversationManager;
  let lock: FileLock;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-01-01T12:00:00.000Z"));
    config = new SubstrateConfig("/test/substrate");
    lock = new FileLock();
    reader = new SubstrateFileReader(fs, config);
    writer = new SubstrateFileWriter(fs, config, lock);
    appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    checker = new PermissionChecker();
    compactor = new MockCompactor();
    manager = new ConversationManager(reader, fs, config, lock, appendWriter, checker, compactor, clock);

    // Initialize CONVERSATION.md
    await fs.writeFile("/test/substrate/CONVERSATION.md", "# Conversation\n\n");
  });

  it("should append message without compaction on first call", async () => {
    await manager.append(AgentRole.EGO, "Hello world");

    const content = await fs.readFile("/test/substrate/CONVERSATION.md");
    expect(content).toContain("[2025-01-01T12:00:00.000Z] [EGO] Hello world");
    expect(compactor.compactCalls).toHaveLength(0);
  });

  it("should not compact when less than an hour has passed", async () => {
    await manager.append(AgentRole.EGO, "First message");

    // Advance 30 minutes
    clock.setNow(new Date("2025-01-01T12:30:00.000Z"));
    await manager.append(AgentRole.EGO, "Second message");

    expect(compactor.compactCalls).toHaveLength(0);
  });

  it("should compact when an hour has passed", async () => {
    await manager.append(AgentRole.EGO, "First message");

    // Advance 1 hour
    clock.setNow(new Date("2025-01-01T13:00:00.000Z"));

    compactor.setResponse("# Conversation\n\nCompacted old messages\n\n## Recent\n\n");
    await manager.append(AgentRole.EGO, "Second message");

    // Should have compacted
    expect(compactor.compactCalls).toHaveLength(1);
    expect(compactor.compactCalls[0].oneHourAgo).toBe("2025-01-01T12:00:00.000Z");

    // Check that compacted content was written
    const content = await fs.readFile("/test/substrate/CONVERSATION.md");
    expect(content).toContain("Compacted old messages");
  });

  it("should compact when more than an hour has passed", async () => {
    await manager.append(AgentRole.EGO, "First message");

    // Advance 2 hours
    clock.setNow(new Date("2025-01-01T14:00:00.000Z"));

    compactor.setResponse("# Conversation\n\nCompacted\n\n");
    await manager.append(AgentRole.EGO, "Second message");

    expect(compactor.compactCalls).toHaveLength(1);
  });

  it("should only compact once per hour interval", async () => {
    await manager.append(AgentRole.EGO, "First message");

    // Advance 1 hour and append
    clock.setNow(new Date("2025-01-01T13:00:00.000Z"));
    compactor.setResponse("# Conversation\n\nCompacted 1\n\n");
    await manager.append(AgentRole.EGO, "Second message");

    expect(compactor.compactCalls).toHaveLength(1);

    // Advance 30 more minutes - should NOT compact again
    clock.setNow(new Date("2025-01-01T13:30:00.000Z"));
    await manager.append(AgentRole.EGO, "Third message");

    expect(compactor.compactCalls).toHaveLength(1);

    // Advance another 30 minutes (total 1 hour since last compaction) - SHOULD compact
    clock.setNow(new Date("2025-01-01T14:00:00.000Z"));
    compactor.setResponse("# Conversation\n\nCompacted 2\n\n");
    await manager.append(AgentRole.EGO, "Fourth message");

    expect(compactor.compactCalls).toHaveLength(2);
  });

  it("should enforce permissions when appending", async () => {
    // Superego cannot append to conversation
    await expect(manager.append(AgentRole.SUPEREGO, "Message"))
      .rejects.toThrow("SUPEREGO does not have APPEND access to CONVERSATION");
  });

  it("should enforce permissions when appending with ID role", async () => {
    // ID cannot append to CONVERSATION
    await expect(manager.append(AgentRole.ID, "Message"))
      .rejects.toThrow("ID does not have APPEND access to CONVERSATION");
  });

  it("should allow force compaction for testing", async () => {
    await manager.append(AgentRole.EGO, "Message");

    compactor.setResponse("# Conversation\n\nForce compacted\n\n");
    await manager.forceCompaction(AgentRole.EGO);

    expect(compactor.compactCalls).toHaveLength(1);

    const content = await fs.readFile("/test/substrate/CONVERSATION.md");
    expect(content).toContain("Force compacted");
  });

  it("should allow reset of compaction timer", async () => {
    await manager.append(AgentRole.EGO, "Message");

    manager.resetCompactionTimer();

    // After reset, should not compact even after an hour
    clock.setNow(new Date("2025-01-01T13:00:00.000Z"));
    await manager.append(AgentRole.EGO, "Second message");

    // First append after reset doesn't compact
    expect(compactor.compactCalls).toHaveLength(0);
  });
});

describe("ConversationManager with archiving", () => {
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let config: SubstrateConfig;
  let reader: SubstrateFileReader;
  let appendWriter: AppendOnlyWriter;
  let checker: PermissionChecker;
  let compactor: MockCompactor;
  let archiver: MockArchiver;
  let manager: ConversationManager;
  let lock: FileLock;
  let writer: SubstrateFileWriter;

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-01-01T12:00:00.000Z"));
    config = new SubstrateConfig("/test/substrate");
    lock = new FileLock();
    reader = new SubstrateFileReader(fs, config);
    writer = new SubstrateFileWriter(fs, config, lock);
    appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    checker = new PermissionChecker();
    compactor = new MockCompactor();
    archiver = new MockArchiver();

    // Initialize CONVERSATION.md
    await fs.writeFile("/test/substrate/CONVERSATION.md", "# Conversation\n\n");
  });

  it("should archive when size threshold is exceeded", async () => {
    const archiveConfig: ConversationArchiveConfig = {
      enabled: true,
      linesToKeep: 2,
      sizeThreshold: 3, // Archive when more than 3 lines
    };

    manager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock,
      archiver, archiveConfig
    );

    // Add 3 messages (will have 3 content lines)
    await manager.append(AgentRole.EGO, "Message 1");
    await manager.append(AgentRole.EGO, "Message 2");
    await manager.append(AgentRole.EGO, "Message 3");

    // Not archived yet (exactly 3 lines)
    expect(archiver.archiveCalls).toHaveLength(0);

    // Add one more to exceed threshold
    archiver.setResponse(2); // Will archive 2 lines
    await manager.append(AgentRole.EGO, "Message 4");

    // Should have archived
    expect(archiver.archiveCalls).toHaveLength(1);
    expect(archiver.archiveCalls[0].linesToKeep).toBe(2);
  });

  it("should archive when time threshold is exceeded", async () => {
    const archiveConfig: ConversationArchiveConfig = {
      enabled: true,
      linesToKeep: 10,
      sizeThreshold: 1000, // High threshold so size doesn't trigger
      timeThresholdMs: 7 * 24 * 60 * 60 * 1000, // 1 week
    };

    manager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock,
      archiver, archiveConfig
    );

    await manager.append(AgentRole.EGO, "Week 1 message");

    // Advance 1 week
    clock.setNow(new Date("2025-01-08T12:00:00.000Z"));
    
    archiver.setResponse(1);
    await manager.append(AgentRole.EGO, "Week 2 message");

    // Should have archived
    expect(archiver.archiveCalls).toHaveLength(1);
  });

  it("should not archive if disabled", async () => {
    const archiveConfig: ConversationArchiveConfig = {
      enabled: false,
      linesToKeep: 2,
      sizeThreshold: 1,
    };

    manager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock,
      archiver, archiveConfig
    );

    await manager.append(AgentRole.EGO, "Message 1");
    await manager.append(AgentRole.EGO, "Message 2");
    await manager.append(AgentRole.EGO, "Message 3");

    // Should not archive even though threshold exceeded
    expect(archiver.archiveCalls).toHaveLength(0);
  });

  it("should support forceArchive for programmatic invocation", async () => {
    const archiveConfig: ConversationArchiveConfig = {
      enabled: true,
      linesToKeep: 5,
      sizeThreshold: 100, // High threshold
    };

    manager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock,
      archiver, archiveConfig
    );

    await manager.append(AgentRole.EGO, "Message 1");
    
    archiver.setResponse(1, "/test/substrate/archive/conversation/forced.md");
    const result = await manager.forceArchive();

    expect(result.success).toBe(true);
    expect(result.linesArchived).toBe(1);
    expect(result.archivedPath).toBe("/test/substrate/archive/conversation/forced.md");
  });

  it("should not call archiver if archiving not configured", async () => {
    manager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock
    );

    await manager.append(AgentRole.EGO, "Message 1");
    await manager.append(AgentRole.EGO, "Message 2");

    // Should not have called archiver
    expect(archiver.archiveCalls).toHaveLength(0);
  });

  it("should reset archive timer", async () => {
    const archiveConfig: ConversationArchiveConfig = {
      enabled: true,
      linesToKeep: 10,
      sizeThreshold: 1000,
      timeThresholdMs: 100, // 100ms
    };

    manager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock,
      archiver, archiveConfig
    );

    await manager.append(AgentRole.EGO, "Message 1");
    
    manager.resetArchiveTimer();

    // After reset, time threshold should not trigger immediately
    clock.setNow(new Date("2025-01-01T12:00:01.000Z"));
    await manager.append(AgentRole.EGO, "Message 2");

    expect(archiver.archiveCalls).toHaveLength(0);
  });
});
