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

function createOrchestrator() {
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
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, writer);
  const id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier);

  const eventSink = new InMemoryEventSink();
  const orchestrator = new LoopOrchestrator(
    ego, subconscious, superego, id,
    appendWriter, clock, new ImmediateTimer(), eventSink,
    defaultLoopConfig(), new InMemoryLogger()
  );

  return { orchestrator, eventSink, launcher };
}

describe("CL-11: Observability & async audit", () => {
  describe("getPendingMessageCount()", () => {
    it("returns 0 when no messages are queued", () => {
      const { orchestrator } = createOrchestrator();
      expect(orchestrator.getPendingMessageCount()).toBe(0);
    });

    it("returns 1 after queueStartupMessage", () => {
      const { orchestrator } = createOrchestrator();
      orchestrator.queueStartupMessage("hello");
      expect(orchestrator.getPendingMessageCount()).toBe(1);
    });

    it("returns cumulative count for multiple queued messages", () => {
      const { orchestrator } = createOrchestrator();
      orchestrator.queueStartupMessage("first");
      orchestrator.queueStartupMessage("second");
      orchestrator.queueStartupMessage("third");
      expect(orchestrator.getPendingMessageCount()).toBe(3);
    });
  });

  describe("audit fire-and-forget", () => {
    it("audit metric is incremented even when audit runs fire-and-forget", async () => {
      const { launcher } = createOrchestrator();
      // superegoAuditInterval=1 means every cycle triggers an audit
      const config = defaultLoopConfig({ superegoAuditInterval: 1, maxConsecutiveIdleCycles: 1 });
      const fs = new InMemoryFileSystem();
      await fs.mkdir("/substrate", { recursive: true });
      await fs.writeFile("/substrate/PLAN.md", "# Plan\n\n## Current Goal\nDone\n\n## Tasks\n- [x] Done");
      await fs.writeFile("/substrate/MEMORY.md", "# Memory\n\n");
      await fs.writeFile("/substrate/HABITS.md", "# Habits\n\n");
      await fs.writeFile("/substrate/SKILLS.md", "# Skills\n\n");
      await fs.writeFile("/substrate/VALUES.md", "# Values\n\n");
      await fs.writeFile("/substrate/ID.md", "# Id\n\n");
      await fs.writeFile("/substrate/SECURITY.md", "# Security\n\n");
      await fs.writeFile("/substrate/CHARTER.md", "# Charter\n\n");
      await fs.writeFile("/substrate/SUPEREGO.md", "# Superego\n\n");
      await fs.writeFile("/substrate/CLAUDE.md", "# Claude\n\n");
      await fs.writeFile("/substrate/PROGRESS.md", "# Progress\n\n");
      await fs.writeFile("/substrate/CONVERSATION.md", "# Conversation\n\n");

      const substrateConfig = new SubstrateConfig("/substrate");
      const reader = new SubstrateFileReader(fs, substrateConfig);
      const lock = new FileLock();
      const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
      const writer = new SubstrateFileWriter(fs, substrateConfig, lock);
      const appendWriter = new AppendOnlyWriter(fs, substrateConfig, lock, clock);
      const checker = new PermissionChecker();
      const promptBuilder = new PromptBuilder(reader, checker);
      const taskClassifier = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
      const compactor = new MockCompactor();
      const conversationManager = new ConversationManager(
        reader, fs, substrateConfig, lock, appendWriter, checker, compactor, clock
      );

      const ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
      const subconscious = new Subconscious(reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
      const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, writer);
      const id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier);

      const sink = new InMemoryEventSink();
      const orc = new LoopOrchestrator(
        ego, subconscious, superego, id,
        appendWriter, clock, new ImmediateTimer(), sink,
        config, new InMemoryLogger()
      );

      // Enqueue audit response
      launcher.enqueueSuccess(JSON.stringify({
        findings: [],
        proposalEvaluations: [],
        summary: "All good",
      }));

      orc.start();
      await orc.runLoop();

      // Audit was fired — the metric is incremented synchronously at start of runAudit()
      expect(orc.getMetrics().superegoAudits).toBeGreaterThanOrEqual(1);
    });
  });
});
