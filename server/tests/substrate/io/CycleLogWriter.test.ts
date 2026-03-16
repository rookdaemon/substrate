/**
 * D-01: CycleLogWriter unit tests
 *
 * Verifies that EGO narration and task execution summaries are routed to
 * cycle_log.md and NOT written to CONVERSATION.md.
 */
import { CycleLogWriter } from "../../../src/substrate/io/CycleLogWriter";
import { InMemoryFileSystem } from "../../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../../src/substrate/abstractions/FixedClock";
import { Ego } from "../../../src/agents/roles/Ego";
import { Subconscious } from "../../../src/agents/roles/Subconscious";
import { PermissionChecker } from "../../../src/agents/permissions";
import { PromptBuilder } from "../../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateFileReader } from "../../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../../src/substrate/io/AppendOnlyWriter";
import { ConversationManager } from "../../../src/conversation/ConversationManager";
import { FileLock } from "../../../src/substrate/io/FileLock";
import { SubstrateConfig } from "../../../src/substrate/config";
import { TaskClassifier } from "../../../src/agents/TaskClassifier";
import { IConversationCompactor } from "../../../src/conversation/IConversationCompactor";

class MockCompactor implements IConversationCompactor {
  async compact(_content: string, _cutoff: string): Promise<string> {
    return "Compacted";
  }
}

function makeSubstrate(substratePath = "/substrate") {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2026-01-15T12:00:00.000Z"));
  const config = new SubstrateConfig(substratePath);
  const reader = new SubstrateFileReader(fs, config);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, config, lock);
  const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker);
  const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
  const conversationManager = new ConversationManager(
    reader, fs, config, lock, appendWriter, checker, new MockCompactor(), clock
  );
  const cycleLogWriter = new CycleLogWriter(fs, clock, substratePath);
  const launcher = new InMemorySessionLauncher();

  return { fs, clock, config, reader, lock, writer, appendWriter, checker, promptBuilder, taskClassifier, conversationManager, cycleLogWriter, launcher };
}

async function seedSubstrateFiles(fs: InMemoryFileSystem, substratePath = "/substrate") {
  await fs.mkdir(substratePath, { recursive: true });
  await fs.writeFile(`${substratePath}/PLAN.md`, "# Plan\n\n## Tasks\n- [ ] Test task");
  await fs.writeFile(`${substratePath}/MEMORY.md`, "# Memory\n\nSome memories");
  await fs.writeFile(`${substratePath}/HABITS.md`, "# Habits\n");
  await fs.writeFile(`${substratePath}/SKILLS.md`, "# Skills\n");
  await fs.writeFile(`${substratePath}/VALUES.md`, "# Values\n\nBe good");
  await fs.writeFile(`${substratePath}/ID.md`, "# Id\n");
  await fs.writeFile(`${substratePath}/SECURITY.md`, "# Security\n");
  await fs.writeFile(`${substratePath}/CHARTER.md`, "# Charter\n");
  await fs.writeFile(`${substratePath}/SUPEREGO.md`, "# Superego\n");
  await fs.writeFile(`${substratePath}/CLAUDE.md`, "# Claude\n");
  await fs.writeFile(`${substratePath}/PROGRESS.md`, "# Progress\n\n");
  await fs.writeFile(`${substratePath}/CONVERSATION.md`, "# Conversation\n\n");
}

describe("CycleLogWriter", () => {
  describe("write()", () => {
    it("appends an entry with timestamp and role tag to cycle_log.md", async () => {
      const { fs, clock, cycleLogWriter } = makeSubstrate();
      await fs.mkdir("/substrate", { recursive: true });

      await cycleLogWriter.write("EGO", "Some narration text");

      const content = await fs.readFile("/substrate/cycle_log.md");
      expect(content).toContain("[2026-01-15T12:00:00.000Z]");
      expect(content).toContain("[EGO]");
      expect(content).toContain("Some narration text");
    });

    it("appends multiple entries sequentially", async () => {
      const { fs, cycleLogWriter } = makeSubstrate();
      await fs.mkdir("/substrate", { recursive: true });

      await cycleLogWriter.write("EGO", "First entry");
      await cycleLogWriter.write("SUBCONSCIOUS", "Second entry");

      const content = await fs.readFile("/substrate/cycle_log.md");
      expect(content).toContain("[EGO] First entry");
      expect(content).toContain("[SUBCONSCIOUS] Second entry");
    });

    it("each entry ends with a newline", async () => {
      const { fs, cycleLogWriter } = makeSubstrate();
      await fs.mkdir("/substrate", { recursive: true });

      await cycleLogWriter.write("EGO", "Entry");

      const content = await fs.readFile("/substrate/cycle_log.md");
      expect(content.endsWith("\n")).toBe(true);
    });
  });
});

describe("D-01: EGO response routing", () => {
  it("Ego.respondToMessage() writes to cycle_log.md, not CONVERSATION.md", async () => {
    const { fs, reader, writer, conversationManager, checker, promptBuilder, taskClassifier, cycleLogWriter, launcher } = makeSubstrate();
    await seedSubstrateFiles(fs);

    const ego = new Ego(
      reader, writer, conversationManager, checker, promptBuilder, launcher,
      new FixedClock(new Date("2026-01-15T12:00:00.000Z")), taskClassifier, "/workspace",
      undefined, cycleLogWriter
    );

    launcher.enqueueSuccess("I have analyzed the situation.");
    await ego.respondToMessage("What is the status?");

    // CONVERSATION.md must not contain the EGO response
    const conversation = await fs.readFile("/substrate/CONVERSATION.md");
    expect(conversation).not.toContain("I have analyzed the situation.");
    expect(conversation).toBe("# Conversation\n\n"); // unchanged from seed

    // cycle_log.md must contain the EGO response with [EGO] tag
    const cycleLog = await fs.readFile("/substrate/cycle_log.md");
    expect(cycleLog).toContain("[EGO] I have analyzed the situation.");
    expect(cycleLog).toContain("[2026-01-15T12:00:00.000Z]");
  });

  it("Subconscious.logConversation() writes to cycle_log.md, not CONVERSATION.md", async () => {
    const { fs, reader, writer, appendWriter, conversationManager, checker, promptBuilder, taskClassifier, cycleLogWriter, launcher } = makeSubstrate();
    await seedSubstrateFiles(fs);

    const subconscious = new Subconscious(
      reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher,
      new FixedClock(new Date("2026-01-15T12:00:00.000Z")), taskClassifier, "/workspace",
      cycleLogWriter
    );

    await subconscious.logConversation("Task executed successfully — no external dependencies.");

    // CONVERSATION.md must not contain the task summary
    const conversation = await fs.readFile("/substrate/CONVERSATION.md");
    expect(conversation).not.toContain("Task executed successfully");
    expect(conversation).toBe("# Conversation\n\n"); // unchanged from seed

    // cycle_log.md must contain the summary with [SUBCONSCIOUS] tag
    const cycleLog = await fs.readFile("/substrate/cycle_log.md");
    expect(cycleLog).toContain("[SUBCONSCIOUS] Task executed successfully — no external dependencies.");
  });

  it("inbound message written to CONVERSATION.md is preserved (not cycle execution output)", async () => {
    // This test verifies the invariant: CONVERSATION.md only grows from inbound
    // messages, not EGO narration (D-01 acceptance criterion).
    const { fs, reader, writer, appendWriter, conversationManager, checker, promptBuilder, taskClassifier, cycleLogWriter, launcher } = makeSubstrate();
    await seedSubstrateFiles(fs);

    // Simulate an inbound message being written to CONVERSATION.md by
    // ConversationManager (as AgoraMessageHandler does it — bypasses Ego/Subconscious).
    await conversationManager.append("EGO" as never, "[AGORA_IN] Hello from peer");

    const conversationBefore = await fs.readFile("/substrate/CONVERSATION.md");
    expect(conversationBefore).toContain("[AGORA_IN] Hello from peer");

    // Now run an EGO response — this must go to cycle_log, not CONVERSATION.md
    const ego = new Ego(
      reader, writer, conversationManager, checker, promptBuilder, launcher,
      new FixedClock(new Date("2026-01-15T12:00:00.000Z")), taskClassifier, "/workspace",
      undefined, cycleLogWriter
    );
    launcher.enqueueSuccess("Acknowledged your message.");
    await ego.respondToMessage("Hello from peer");

    const conversationAfter = await fs.readFile("/substrate/CONVERSATION.md");
    // The inbound message is still there
    expect(conversationAfter).toContain("[AGORA_IN] Hello from peer");
    // The EGO response is NOT in CONVERSATION.md
    expect(conversationAfter).not.toContain("Acknowledged your message.");

    // EGO response IS in cycle_log.md
    const cycleLog = await fs.readFile("/substrate/cycle_log.md");
    expect(cycleLog).toContain("[EGO] Acknowledged your message.");
  });
});
