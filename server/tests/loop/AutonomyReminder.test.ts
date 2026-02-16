import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { ImmediateTimer } from "../../src/loop/ImmediateTimer";
import { defaultLoopConfig } from "../../src/loop/types";
import { InMemoryLogger } from "../../src/logging";
import { Ego } from "../../src/agents/roles/Ego";
import { Subconscious } from "../../src/agents/roles/Subconscious";
import { Superego } from "../../src/agents/roles/Superego";
import { Id } from "../../src/agents/roles/Id";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../src/substrate/io/FileLock";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { TaskClassifier } from "../../src/agents/TaskClassifier";
import { ConversationManager } from "../../src/conversation/ConversationManager";
import { IConversationCompactor } from "../../src/conversation/IConversationCompactor";

class MockCompactor implements IConversationCompactor {
  async compact(_currentContent: string, _oneHourAgo: string): Promise<string> {
    return "Compacted content";
  }
}

function createDeps() {
  const fs = new InMemoryFileSystem();
  const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
  const launcher = new InMemorySessionLauncher();
  const config = new SubstrateConfig("/substrate");
  const reader = new SubstrateFileReader(fs, config);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, config, lock);
  const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker);
  const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
  const compactor = new MockCompactor();
  const conversationManager = new ConversationManager(
    reader, fs, config, lock, appendWriter, checker, compactor, clock
  );

  const ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
  const subconscious = new Subconscious(reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier);
  const id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier);

  return { fs, clock, launcher, appendWriter, ego, subconscious, superego, id };
}

async function setupSubstrate(fs: InMemoryFileSystem) {
  await fs.mkdir("/substrate", { recursive: true });
  await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nDone\n\n## Tasks\n- [x] Done");
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
}

describe("LoopOrchestrator: Autonomy Reminder", () => {
  it("injects autonomy reminder at configured interval", async () => {
    const deps = createDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ 
      superegoAuditInterval: 100,
      maxConsecutiveIdleCycles: 20
    });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      { ...config, autonomyReminderInterval: 5 },
      new InMemoryLogger()
    );

    orchestrator.start();
    for (let i = 0; i < 15; i++) {
      await orchestrator.runOneCycle();
    }

    const events = eventSink.getEvents();
    const reminderEvents = events.filter((e) => e.type === "autonomy_reminder_injected");
    const cycleNumbers = reminderEvents.map(e => e.data.cycleNumber as number).sort((a, b) => a - b);
    
    expect(reminderEvents.length).toBe(3);
    expect(cycleNumbers).toEqual([5, 10, 15]);
  });

  it("injects message with reminder content", async () => {
    const deps = createDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ 
      superegoAuditInterval: 100,
      maxConsecutiveIdleCycles: 6
    });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      { ...config, autonomyReminderInterval: 3 },
      new InMemoryLogger()
    );

    orchestrator.start();
    for (let i = 0; i < 3; i++) {
      await orchestrator.runOneCycle();
    }

    const events = eventSink.getEvents();
    const messageEvents = events.filter((e) => e.type === "message_injected");
    const reminderMessage = messageEvents.find(e => 
      (e.data.message as string).includes("[Autonomy Reminder]")
    );
    
    expect(reminderMessage).toBeDefined();
    const message = reminderMessage!.data.message as string;
    expect(message).toContain("Three-part test");
    expect(message).toContain("Should I...?");
    expect(message).toContain("Would you like me to...?");
    expect(message).toContain("Do you want me to...?");
    expect(message).toContain("compliance reflexes");
  });

  it("does not inject reminder when interval is 0", async () => {
    const deps = createDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ 
      superegoAuditInterval: 100,
      maxConsecutiveIdleCycles: 6
    });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      { ...config, autonomyReminderInterval: 0 },
      new InMemoryLogger()
    );

    orchestrator.start();
    for (let i = 0; i < 5; i++) {
      await orchestrator.runOneCycle();
    }

    const events = eventSink.getEvents();
    const reminderEvents = events.filter((e) => e.type === "autonomy_reminder_injected");
    expect(reminderEvents.length).toBe(0);
  });

  it("does not inject reminder when interval is undefined", async () => {
    const deps = createDeps();
    await setupSubstrate(deps.fs);

    const eventSink = new InMemoryEventSink();
    const config = defaultLoopConfig({ 
      superegoAuditInterval: 100,
      maxConsecutiveIdleCycles: 6
    });
    const orchestrator = new LoopOrchestrator(
      deps.ego, deps.subconscious, deps.superego, deps.id,
      deps.appendWriter, deps.clock, new ImmediateTimer(), eventSink,
      { ...config, autonomyReminderInterval: undefined },
      new InMemoryLogger()
    );

    orchestrator.start();
    for (let i = 0; i < 5; i++) {
      await orchestrator.runOneCycle();
    }

    const events = eventSink.getEvents();
    const reminderEvents = events.filter((e) => e.type === "autonomy_reminder_injected");
    expect(reminderEvents.length).toBe(0);
  });
});
