import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { Ego } from "../../src/agents/roles/Ego";
import { Subconscious } from "../../src/agents/roles/Subconscious";
import { Superego } from "../../src/agents/roles/Superego";
import { Id } from "../../src/agents/roles/Id";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { SubstrateConfig } from "../../src/substrate/config";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileWriter } from "../../src/substrate/io/FileWriter";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { FileLock } from "../../src/substrate/io/FileLock";
import { PermissionChecker } from "../../src/agents/permissions";
import { PromptBuilder } from "../../src/agents/prompts/PromptBuilder";
import { InMemorySessionLauncher } from "../../src/agents/claude/InMemorySessionLauncher";
import { TaskClassifier } from "../../src/agents/TaskClassifier";
import { ConversationManager } from "../../src/conversation/ConversationManager";
import { ConversationCompactor } from "../../src/conversation/ConversationCompactor";
import { InMemoryEventSink } from "../../src/loop/InMemoryEventSink";
import { NodeTimer } from "../../src/loop/NodeTimer";
import { defaultLoopConfig } from "../../src/loop/types";
import { InMemoryLogger } from "../../src/logging";

describe("ConversationGate and TickGating", () => {
  let orchestrator: LoopOrchestrator;
  let ego: Ego;
  let launcher: InMemorySessionLauncher;
  let eventSink: InMemoryEventSink;
  let clock: FixedClock;
  let injectedMessages: string[];

  beforeEach(async () => {
    injectedMessages = [];
    const fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2025-06-15T10:00:00Z"));
    const substrateConfig = new SubstrateConfig("/test/substrate");
    const reader = new SubstrateFileReader(fs, substrateConfig);
    const writer = new SubstrateFileWriter(fs, substrateConfig, new FileLock());
    const appendWriter = new AppendOnlyWriter(fs, substrateConfig, new FileLock(), clock);
    const checker = new PermissionChecker();
    const promptBuilder = new PromptBuilder(reader, checker, { substratePath: "/test/substrate" });
    launcher = new InMemorySessionLauncher();
    const taskClassifier = new TaskClassifier({
      strategicModel: "opus",
      tacticalModel: "sonnet",
    });
    const compactor = new ConversationCompactor(launcher, "/test/substrate");
    const conversationManager = new ConversationManager(
      reader, fs, substrateConfig, new FileLock(), appendWriter, checker, compactor, clock
    );

    ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
    const subconscious = new Subconscious(reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier);
    const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier);
    const id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier);

    eventSink = new InMemoryEventSink();
    const timer = new NodeTimer();
    const logger = new InMemoryLogger();
    const config = defaultLoopConfig();

    orchestrator = new LoopOrchestrator(
      ego, subconscious, superego, id,
      appendWriter, clock, timer, eventSink, config,
      logger, undefined, 60_000 // conversationIdleTimeoutMs: 60s
    );

    // Set up launcher for injection (mock inject method)
    orchestrator.setLauncher({ 
      inject: (msg: string) => {
        injectedMessages.push(msg);
      }
    });
  });

  describe("handleUserMessage - chat routing", () => {
    it("injects message when tick is active", async () => {
      // Start a tick (simulate tickInProgress)
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (orchestrator as any).tickInProgress = true;

      await orchestrator.handleUserMessage("Hello");

      // Should have called injectMessage
      expect(injectedMessages).toContain("Hello");
      
      // Check via event sink
      const events = eventSink.getEvents();
      const responseEvent = events.find((e) => e.type === "conversation_response");
      expect(responseEvent).toBeDefined();
      expect(responseEvent?.data.response).toContain("injected");
    });

    it("starts new conversation session when neither tick nor conversation active", async () => {
      launcher.enqueueSuccess("Response from Ego");

      await orchestrator.handleUserMessage("Hello");

      const events = eventSink.getEvents();
      const responseEvent = events.find((e) => e.type === "conversation_response");
      expect(responseEvent).toBeDefined();
      expect(responseEvent?.data.response).toBe("Response from Ego");
      
      // Verify idleTimeoutMs was passed
      const launches = launcher.getLaunches();
      expect(launches.length).toBe(1);
      expect(launches[0].options?.idleTimeoutMs).toBe(60_000);
    });

    it("queues second message when conversation session is starting", async () => {
      // Make launcher hang by not enqueueing a response immediately
      // First message starts session
      const handle1Promise = orchestrator.handleUserMessage("First");
      
      // Second message should be queued
      const handle2Promise = orchestrator.handleUserMessage("Second");

      // Now enqueue responses for both
      launcher.enqueueSuccess("First response");
      launcher.enqueueSuccess("Second response");

      await handle1Promise;
      await handle2Promise;

      // Both should eventually be processed
      const events = eventSink.getEvents();
      const responseEvents = events.filter((e) => e.type === "conversation_response");
      expect(responseEvents.length).toBeGreaterThanOrEqual(1);
    });
  });

  describe("tick gating", () => {
    it("defers tick when conversation session is active", async () => {
      // Start a conversation session
      launcher.enqueueSuccess("Response");
      const handlePromise = orchestrator.handleUserMessage("Hello");

      // Try to run a tick (simulate runOneTick being called)
      // Since conversation is active, tick should be deferred
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const tickResult = await (orchestrator as any).runOneTick();

      expect(tickResult.error).toContain("Deferred");
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((orchestrator as any).tickRequested).toBe(true);

      await handlePromise;
    });

    it("runs tick immediately when conversation session closes and tickRequested", async () => {
      // Set orchestrator state to RUNNING (required for tickRequested to be cleared)
      orchestrator.start();

      // Set up: conversation active, tick requested
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (orchestrator as any).conversationSessionActive = true;
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (orchestrator as any).tickRequested = true;

      // Close conversation session
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (orchestrator as any).onConversationSessionClosed();

      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((orchestrator as any).tickRequested).toBe(false);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((orchestrator as any).conversationSessionActive).toBe(false);
    });
  });
});
