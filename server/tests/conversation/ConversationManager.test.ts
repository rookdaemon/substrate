import { ConversationManager } from "../../src/conversation/ConversationManager";
import { IConversationCompactor } from "../../src/conversation/IConversationCompactor";
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
