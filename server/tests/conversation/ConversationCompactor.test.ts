import { ConversationCompactor } from "../../src/conversation/ConversationCompactor";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";

describe("ConversationCompactor", () => {
  let launcher: InMemorySessionLauncher;
  let compactor: ConversationCompactor;

  beforeEach(() => {
    launcher = new InMemorySessionLauncher();
    compactor = new ConversationCompactor(launcher);
  });

  it("should return content as-is when all entries are recent", async () => {
    const oneHourAgo = "2025-01-01T10:00:00.000Z";
    const content = 
      `# Conversation\n\n` +
      `[2025-01-01T10:30:00.000Z] [EGO] Hello\n` +
      `[2025-01-01T10:35:00.000Z] [USER] Hi there\n`;

    const result = await compactor.compact(content, oneHourAgo);

    expect(result).toBe(content);
  });

  it("should compact old entries and keep recent ones detailed", async () => {
    const oneHourAgo = "2025-01-01T10:00:00.000Z";
    const content = 
      `# Conversation\n\n` +
      `[2025-01-01T09:00:00.000Z] [USER] What is the plan?\n` +
      `[2025-01-01T09:01:00.000Z] [EGO] The plan is to implement feature X\n` +
      `[2025-01-01T10:30:00.000Z] [USER] How is it going?\n` +
      `[2025-01-01T10:35:00.000Z] [EGO] Making good progress\n`;

    launcher.enqueue({
      rawOutput: "User asked about plan, I explained feature X implementation",
      exitCode: 0,
      durationMs: 100,
      success: true
    });

    const result = await compactor.compact(content, oneHourAgo);

    expect(result).toContain("# Conversation");
    expect(result).toContain("## Summary of Earlier Conversation");
    expect(result).toContain("User asked about plan, I explained feature X implementation");
    expect(result).toContain("## Recent Conversation (Last Hour)");
    expect(result).toContain("[2025-01-01T10:30:00.000Z] [USER] How is it going?");
    expect(result).toContain("[2025-01-01T10:35:00.000Z] [EGO] Making good progress");
    expect(result).not.toContain("[2025-01-01T09:00:00.000Z]");
    expect(result).not.toContain("[2025-01-01T09:01:00.000Z]");
  });

  it("should handle summarization failure gracefully", async () => {
    const oneHourAgo = "2025-01-01T10:00:00.000Z";
    const content = 
      `[2025-01-01T09:00:00.000Z] [USER] Old message\n` +
      `[2025-01-01T10:30:00.000Z] [USER] New message\n`;

    launcher.enqueue({
      rawOutput: "",
      exitCode: 1,
      durationMs: 100,
      success: false,
      error: "Failed to summarize"
    });

    const result = await compactor.compact(content, oneHourAgo);

    expect(result).toContain("Previous conversation history compacted");
    expect(result).toContain("[2025-01-01T10:30:00.000Z] [USER] New message");
  });

  it("should preserve header lines in compacted output", async () => {
    const oneHourAgo = "2025-01-01T10:00:00.000Z";
    const content = 
      `# Conversation\n` +
      `## Instructions\n\n` +
      `[2025-01-01T09:00:00.000Z] [USER] Old message\n` +
      `[2025-01-01T10:30:00.000Z] [USER] New message\n`;

    launcher.enqueue({
      rawOutput: "Summary of old conversation",
      exitCode: 0,
      durationMs: 100,
      success: true
    });

    const result = await compactor.compact(content, oneHourAgo);

    expect(result).toContain("# Conversation");
    expect(result).toContain("## Instructions");
  });

  it("should handle empty content", async () => {
    const oneHourAgo = "2025-01-01T10:00:00.000Z";
    const content = "";

    const result = await compactor.compact(content, oneHourAgo);

    expect(result).toBe("");
  });

  it("should handle content with no timestamps", async () => {
    const oneHourAgo = "2025-01-01T10:00:00.000Z";
    const content = 
      `# Conversation\n` +
      `This is some text without timestamps\n`;

    const result = await compactor.compact(content, oneHourAgo);

    expect(result).toBe(content);
  });
});
