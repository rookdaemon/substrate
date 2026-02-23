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
import { ISessionLauncher, ClaudeSessionRequest, ClaudeSessionResult, LaunchOptions } from "../../src/agents/claude/ISessionLauncher";
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
    const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, writer);
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
      },
      isActive: () => true,
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

    it("terminates session and emits error when max duration exceeded", async () => {
      // Launcher that resolves after 5 seconds — far longer than maxDuration below
      class SlowSessionLauncher implements ISessionLauncher {
        async launch(_req: ClaudeSessionRequest, _opts?: LaunchOptions): Promise<ClaudeSessionResult> {
          await new Promise(resolve => setTimeout(resolve, 5_000));
          return { rawOutput: "", exitCode: 0, durationMs: 5_000, success: true };
        }
      }

      const fs2 = new InMemoryFileSystem();
      const clock2 = new FixedClock(new Date("2025-06-15T10:00:00Z"));
      const substrateConfig2 = new SubstrateConfig("/test/substrate2");
      const reader2 = new SubstrateFileReader(fs2, substrateConfig2);
      const writer2 = new SubstrateFileWriter(fs2, substrateConfig2, new FileLock());
      const appendWriter2 = new AppendOnlyWriter(fs2, substrateConfig2, new FileLock(), clock2);
      const checker2 = new PermissionChecker();
      const promptBuilder2 = new PromptBuilder(reader2, checker2, { substratePath: "/test/substrate2" });
      const slowLauncher = new SlowSessionLauncher();
      const taskClassifier2 = new TaskClassifier({ strategicModel: "opus", tacticalModel: "sonnet" });
      const compactor2 = new ConversationCompactor(slowLauncher, "/test/substrate2");
      const conversationManager2 = new ConversationManager(
        reader2, fs2, substrateConfig2, new FileLock(), appendWriter2, checker2, compactor2, clock2
      );
      const slowEgo = new Ego(reader2, writer2, conversationManager2, checker2, promptBuilder2, slowLauncher, clock2, taskClassifier2);
      const subconscious2 = new Subconscious(reader2, writer2, appendWriter2, conversationManager2, checker2, promptBuilder2, slowLauncher, clock2, taskClassifier2);
      const superego2 = new Superego(reader2, appendWriter2, checker2, promptBuilder2, slowLauncher, clock2, taskClassifier2, writer2);
      const id2 = new Id(reader2, checker2, promptBuilder2, slowLauncher, clock2, taskClassifier2);

      const freshSink = new InMemoryEventSink();
      const freshTimer = new NodeTimer();
      const freshLogger = new InMemoryLogger();
      const freshConfig = defaultLoopConfig();

      const shortOrchestrator = new LoopOrchestrator(
        slowEgo, subconscious2, superego2, id2,
        appendWriter2, clock2, freshTimer, freshSink, freshConfig,
        freshLogger, undefined, 60_000, undefined, undefined, 50 // maxDuration: 50ms
      );

      await shortOrchestrator.handleUserMessage("Hello");

      // Conversation session should be closed after timeout
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      expect((shortOrchestrator as any).conversationSessionActive).toBe(false);

      // Error event should be emitted with timeout message
      const events = freshSink.getEvents();
      const responseEvent = events.find((e) => e.type === "conversation_response");
      expect(responseEvent).toBeDefined();
      expect(responseEvent?.data.error).toContain("exceeded max duration");
    }, 10_000);
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
