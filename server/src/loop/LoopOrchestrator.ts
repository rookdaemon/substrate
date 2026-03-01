import { Ego } from "../agents/roles/Ego";
import { Subconscious, TaskResult, OutcomeEvaluation, AgoraReply } from "../agents/roles/Subconscious";
import { Superego } from "../agents/roles/Superego";
import { Id } from "../agents/roles/Id";
import { ProcessLogEntry } from "../agents/claude/ISessionLauncher";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { IClock } from "../substrate/abstractions/IClock";
import { ILogger } from "../logging";
import { ITimer } from "./ITimer";
import { ILoopEventSink } from "./ILoopEventSink";
import { IdleHandler } from "./IdleHandler";
import {
  LoopState,
  LoopConfig,
  CycleResult,
  TickResult,
  LoopMetrics,
  createInitialMetrics,
} from "./types";
import { SessionManager, SessionConfig } from "../session/SessionManager";
import { TickPromptBuilder } from "../session/TickPromptBuilder";
import { SdkSessionFactory } from "../session/ISdkSession";
import { parseRateLimitReset } from "./rateLimitParser";
import { RateLimitStateManager } from "./RateLimitStateManager";
import { SchedulerCoordinator } from "./SchedulerCoordinator";
import { LoopWatchdog } from "./LoopWatchdog";
import { SuperegoFindingTracker } from "../agents/roles/SuperegoFindingTracker";
import { IMessageInjector } from "./IMessageInjector";
import { GovernanceReportStore } from "../evaluation/GovernanceReportStore";
import { DriveQualityTracker } from "../evaluation/DriveQualityTracker";
import { PerformanceMetrics } from "../evaluation/PerformanceMetrics";
import { msgPreview } from "./utils";
import { DeferredWorkQueue } from "./DeferredWorkQueue";
import { EndorsementInterceptor } from "../agents/endorsement";
import type { IAgoraService } from "../agora/IAgoraService";

export class LoopOrchestrator implements IMessageInjector {
  private state: LoopState = LoopState.STOPPED;
  private metrics: LoopMetrics = createInitialMetrics();
  private cycleNumber = 0;
  private isProcessing = false;

  private auditOnNextCycle = false;
  private rateLimitUntil: string | null = null;

  // Message injection — works in both cycle and tick mode
  private launcher: { inject(message: string): void; isActive(): boolean } | null = null;
  private shutdownFn: ((exitCode: number) => void) | null = null;

  // Scheduler coordinator — runs all due schedulers each cycle
  private schedulerCoordinator: SchedulerCoordinator | null = null;

  // Watchdog — detects stalls and injects gentle reminders
  private watchdog: LoopWatchdog | null = null;

  // Rate limit state manager for hibernation context
  private rateLimitStateManager: RateLimitStateManager | null = null;

  // Governance report store for persisting audit reports
  private reportStore: GovernanceReportStore | null = null;

  // Drive quality tracker for Id learning loop
  private driveQualityTracker: DriveQualityTracker | null = null;

  // Performance metrics — records cycle timing, api_call events, and substrate_io events
  private performanceMetrics: PerformanceMetrics | null = null;

  // SUPEREGO finding tracker for recurring finding escalation
  private findingTracker: SuperegoFindingTracker = new SuperegoFindingTracker();

  // Optional callback to persist finding tracker state after each audit
  private findingTrackerSave: (() => Promise<void>) | null = null;

  // Last cycle diagnostics for health reporting
  private lastCycleAt: Date | null = null;
  private lastCycleResult: "success" | "failure" | "idle" | "none" = "none";

  // Tick mode
  private tickPromptBuilder: TickPromptBuilder | null = null;
  private sdkSessionFactory: SdkSessionFactory | null = null;
  private activeSessionManager: SessionManager | null = null;
  private tickNumber = 0;
  private pendingMessages: string[] = [];

  // Tick state for deferred tick logic
  private tickRequested = false;
  private tickInProgress = false;

  // Deferred work queue — overlaps post-execution work with next cycle dispatch
  private readonly deferredWork: DeferredWorkQueue;

  // Endorsement interceptor — compliance circuit-breaker
  private endorsementInterceptor: EndorsementInterceptor | null = null;

  // Agora service — sends agoraReplies from Subconscious/Ego structured JSON output
  private agoraService: IAgoraService | null = null;

  // Conversation session gate
  private conversationSessionActive = false;
  private conversationSessionPromise: Promise<void> | null = null;
  private conversationMessageQueue: string[] = [];
  private readonly conversationIdleTimeoutMs: number;
  private readonly conversationSessionMaxDurationMs: number;

  // Sleep/wake callbacks and loop resume function
  private resumeLoopFn: (() => Promise<void>) | null = null;
  private onSleepEnter: (() => Promise<void>) | null = null;
  private onSleepExit: (() => Promise<void>) | null = null;

  constructor(
    private readonly ego: Ego,
    private readonly subconscious: Subconscious,
    private readonly superego: Superego,
    private readonly _id: Id,
    private readonly _appendWriter: AppendOnlyWriter,
    private readonly clock: IClock,
    private readonly timer: ITimer,
    private readonly eventSink: ILoopEventSink,
    private readonly config: LoopConfig,
    private readonly logger: ILogger,
    private readonly idleHandler?: IdleHandler,
    conversationIdleTimeoutMs?: number,
    findingTracker?: SuperegoFindingTracker,
    findingTrackerSave?: () => Promise<void>,
    conversationSessionMaxDurationMs?: number,
  ) {
    this.conversationIdleTimeoutMs = conversationIdleTimeoutMs ?? 20_000; // Default 20s
    this.conversationSessionMaxDurationMs = conversationSessionMaxDurationMs ?? 300_000; // Default 5 min
    if (findingTracker) {
      this.findingTracker = findingTracker;
    }
    this.findingTrackerSave = findingTrackerSave ?? null;
    this.deferredWork = new DeferredWorkQueue(
      (err) => this.logger.warn(`deferred work failed: ${err.message}`)
    );
  }

  getState(): LoopState {
    return this.state;
  }

  getMetrics(): LoopMetrics {
    return { ...this.metrics };
  }

  getRateLimitUntil(): string | null {
    return this.rateLimitUntil;
  }

  /** Drain deferred background work. Exposed for testing and graceful shutdown. */
  async drainDeferredWork(): Promise<void> {
    await this.deferredWork.drain();
  }

  getPendingMessageCount(): number {
    return this.pendingMessages.length;
  }

  isEffectivelyPaused(): boolean {
    return this.state === LoopState.PAUSED || this.rateLimitUntil !== null;
  }

  start(): void {
    if (this.state === LoopState.STOPPED) {
      // Normal start from stopped
      this.logger.debug("start() called");
      this.transition(LoopState.RUNNING);
      this.watchdog?.recordActivity();
    } else if (this.state === LoopState.SLEEPING) {
      // Wake from sleep
      this.logger.debug("start() called — waking from SLEEPING");
      this.wake();
    } else if (this.state === LoopState.RUNNING && this.rateLimitUntil !== null) {
      // Start during rate limit = try again (clear rate limit)
      this.logger.debug("start() called during rate limit — clearing rate limit");
      this.rateLimitUntil = null;
      this.timer.wake(); // Wake up the loop immediately
    } else {
      throw new Error(`Cannot start: loop is in ${this.state} state${this.rateLimitUntil ? ' (rate limited)' : ''}`);
    }
  }

  pause(): void {
    if (this.state !== LoopState.RUNNING) {
      throw new Error(`Cannot pause: loop is in ${this.state} state`);
    }
    this.logger.debug("pause() called");
    this.transition(LoopState.PAUSED);
  }

  resume(): void {
    if (this.state !== LoopState.PAUSED) {
      throw new Error(`Cannot resume: loop is in ${this.state} state`);
    }
    this.logger.debug("resume() called");
    this.transition(LoopState.RUNNING);
  }

  stop(userInitiated = false): void {
    if (this.state === LoopState.STOPPED) {
      return;
    }
    this.logger.debug("stop() called — exiting gracefully");
    this.watchdog?.stop();
    // Clear sleep state if sleeping
    if (this.state === LoopState.SLEEPING) {
      this.onSleepExit?.().catch(() => {});
    }
    this.transition(LoopState.STOPPED);
    if (this.shutdownFn && userInitiated) {
      this.shutdownFn(76); // Exit with code 76 (user-initiated stop — supervisor restarts without auto-start)
    }
  }

  /**
   * Wake from SLEEPING state: transition to RUNNING and resume the cycle/tick loop.
   * Can be triggered by incoming messages, HTTP wake endpoint, or manual start.
   */
  wake(): void {
    if (this.state !== LoopState.SLEEPING) {
      throw new Error(`Cannot wake: loop is in ${this.state} state`);
    }
    this.logger.debug("wake() called");
    this.transition(LoopState.RUNNING);
    this.onSleepExit?.().catch((err) => {
      this.logger.debug(`wake: onSleepExit failed — ${err instanceof Error ? err.message : String(err)}`);
    });
    this.resumeLoopFn?.().catch((err) => {
      this.logger.debug(`wake: resumeLoopFn failed — ${err instanceof Error ? err.message : String(err)}`);
    });
    this.watchdog?.recordActivity();
  }

  /**
   * Initialize orchestrator in SLEEPING state (for restart-resilient sleep persistence).
   * Only valid when state is STOPPED (before any loop has started).
   */
  initializeSleeping(): void {
    if (this.state !== LoopState.STOPPED) {
      return;
    }
    this.logger.debug("initializeSleeping() — starting in SLEEPING state");
    this.state = LoopState.SLEEPING;
  }

  setResumeLoopFn(fn: () => Promise<void>): void {
    this.resumeLoopFn = fn;
  }

  setSleepCallbacks(onEnter: () => Promise<void>, onExit: () => Promise<void>): void {
    this.onSleepEnter = onEnter;
    this.onSleepExit = onExit;
  }

  setLauncher(launcher: { inject(message: string): void; isActive(): boolean }): void {
    this.launcher = launcher;
  }

  /**
   * Queue a startup message to be injected at the start of the first active session.
   * Used by the startup scan to recover [UNPROCESSED] messages after a restart.
   * In tick mode: consumed at the start of the next tick.
   * In cycle mode: consumed on the next cycle (with task, or via Ego when idle).
   */
  queueStartupMessage(message: string): void {
    this.pendingMessages.push(message);
    this.logger.debug(`queueStartupMessage: queued startup message (${message.length} chars)`);
  }

  setShutdown(fn: (exitCode: number) => void): void {
    this.shutdownFn = fn;
  }

  setSchedulerCoordinator(coordinator: SchedulerCoordinator): void {
    this.schedulerCoordinator = coordinator;
  }

  getCycleNumber(): number {
    return this.cycleNumber;
  }

  getLastCycleDiagnostics(): { lastCycleAt: Date | null; lastCycleResult: "success" | "failure" | "idle" | "none" } {
    return { lastCycleAt: this.lastCycleAt, lastCycleResult: this.lastCycleResult };
  }

  setWatchdog(watchdog: LoopWatchdog): void {
    this.watchdog = watchdog;
  }

  setRateLimitStateManager(manager: RateLimitStateManager): void {
    this.rateLimitStateManager = manager;
  }

  /**
   * Set the rateLimitUntil timestamp directly (e.g. restored from disk on startup).
   * A null value clears any active rate-limit marker.
   */
  setRateLimitUntil(value: string | null): void {
    this.rateLimitUntil = value;
  }

  setReportStore(store: GovernanceReportStore): void {
    this.reportStore = store;
  }

  setDriveQualityTracker(tracker: DriveQualityTracker): void {
    this.driveQualityTracker = tracker;
  }

  setPerformanceMetrics(metrics: PerformanceMetrics): void {
    this.performanceMetrics = metrics;
  }

  setEndorsementInterceptor(interceptor: EndorsementInterceptor): void {
    this.endorsementInterceptor = interceptor;
  }

  /**
   * Set the Agora service for sending agoraReplies from structured JSON output.
   * When set, the orchestrator will send any agoraReplies returned by
   * Subconscious.execute() after the execution completes.
   */
  setAgoraService(service: IAgoraService): void {
    this.agoraService = service;
  }

  requestRestart(): void {
    this.logger.debug("requestRestart() called — exiting for supervisor restart");
    this.eventSink.emit({
      type: "restart_requested",
      timestamp: this.clock.now().toISOString(),
      data: {},
    });
    this.transition(LoopState.STOPPED);
    if (this.shutdownFn) {
      this.shutdownFn(75); // Exit with code 75 (restart signal)
    }
  }

  nudge(): void {
    this.logger.debug("nudge() — waking timer for immediate cycle");
    this.timer.wake();
  }

  requestAudit(): void {
    this.auditOnNextCycle = true;
    this.eventSink.emit({
      type: "evaluation_requested",
      timestamp: this.clock.now().toISOString(),
      data: {},
    });
  }

  async runOneCycle(): Promise<CycleResult> {
    if (this.isProcessing) {
      this.logger.debug("runOneCycle() skipped — already processing");
      return {
        cycleNumber: this.cycleNumber,
        action: "idle",
        success: true,
        summary: "Skipped — cycle already in progress",
      };
    }

    this.isProcessing = true;
    try {
      return await this.executeOneCycle();
    } finally {
      this.isProcessing = false;
    }
  }

  private async executeOneCycle(): Promise<CycleResult> {
    this.cycleNumber++;
    this.metrics.totalCycles++;

    this.logger.debug(`cycle ${this.cycleNumber}: starting`);
    this.watchdog?.recordActivity();
    const cycleStartMs = this.clock.now().getTime();

    // Drain deferred work from previous cycle before dispatching
    await this.deferredWork.drain();

    const dispatch = await this.ego.dispatchNext();

    let result: CycleResult;

    if (!dispatch) {
      this.metrics.idleCycles++;
      this.metrics.consecutiveIdleCycles++;

      // Cycle mode: process pending messages (e.g. Agora) when idle so they get a response
      if (this.pendingMessages.length > 0) {
        const toProcess = [...this.pendingMessages];
        this.pendingMessages = [];
        this.logger.debug(`cycle ${this.cycleNumber}: processing ${toProcess.length} pending message(s) (no task)`);
        const combined = toProcess.join("\n\n---\n\n");
        try {
          const egoResponse = await this.ego.respondToMessage(combined, this.createLogCallback("EGO"));
          if (egoResponse) await this.checkEndorsement(egoResponse);
        } catch (err) {
          this.logger.debug(`cycle ${this.cycleNumber}: pending message response failed — ${err instanceof Error ? err.message : String(err)}`);
        }
        // Processing messages is real work — reset idle counter to avoid premature sleep
        this.metrics.consecutiveIdleCycles = 0;
      }

      this.logger.debug(`cycle ${this.cycleNumber}: idle (consecutive: ${this.metrics.consecutiveIdleCycles})`);

      result = {
        cycleNumber: this.cycleNumber,
        action: "idle",
        success: true,
        summary: "No tasks available — idle",
      };

      this.eventSink.emit({
        type: "idle",
        timestamp: this.clock.now().toISOString(),
        data: { consecutiveIdleCycles: this.metrics.consecutiveIdleCycles },
      });
    } else {
      this.logger.debug(`cycle ${this.cycleNumber}: dispatching task "${dispatch.taskId}"`);

      const pending = this.pendingMessages.length > 0 ? [...this.pendingMessages] : undefined;
      if (pending?.length) {
        this.pendingMessages = [];
        this.logger.debug(`cycle ${this.cycleNumber}: including ${pending.length} pending message(s) with task`);
      }

      const apiCallStartMs = this.clock.now().getTime();
      const taskResult = await this.subconscious.execute(
        {
          taskId: dispatch.taskId,
          description: dispatch.description,
        },
        this.createLogCallback("SUBCONSCIOUS"),
        pending
      );
      const apiCallDurationMs = this.clock.now().getTime() - apiCallStartMs;
      // Best-effort — fire-and-forget so metrics never block the loop
      this.performanceMetrics?.recordApiCall(apiCallDurationMs, "SUBCONSCIOUS", "execute").catch(() => {});

      const success = taskResult.result === "success";

      this.logger.debug(`cycle ${this.cycleNumber}: task "${dispatch.taskId}" ${success ? "succeeded" : "failed"} — ${taskResult.summary}`);

      if (success) {
        this.metrics.successfulCycles++;
        this.metrics.consecutiveIdleCycles = 0;

        await this.subconscious.markTaskComplete(dispatch.taskId);

        if (taskResult.progressEntry) {
          await this.subconscious.logProgress(taskResult.progressEntry);
        }

        if (taskResult.skillUpdates) {
          await this.subconscious.updateSkills(taskResult.skillUpdates);
        }

        if (taskResult.memoryUpdates) {
          await this.subconscious.updateMemory(taskResult.memoryUpdates);
        }

        if (taskResult.summary) {
          await this.subconscious.logConversation(taskResult.summary);
        }
      } else {
        this.metrics.failedCycles++;

        if (taskResult.summary) {
          await this.subconscious.logConversation(taskResult.summary);
        }
      }

      // Send agoraReplies from structured JSON output (if any)
      // This moves Agora sends from LLM tool calls into the orchestrator,
      // enabling pure text-in → JSON-out execution for self-hosted models.
      if (taskResult.agoraReplies.length > 0 && this.agoraService) {
        this.deferredWork.enqueue(this.sendAgoraReplies(taskResult.agoraReplies));
      }

      // Drive learning: if task was Id-generated, record a quality rating for future drive improvement
      await this.recordDriveRatingIfApplicable(dispatch.description, taskResult);

      // Enqueue proposal evaluation as deferred work (overlaps with next cycle's dispatch)
      if (taskResult.proposals.length > 0) {
        this.logger.debug(`cycle ${this.cycleNumber}: deferring evaluation of ${taskResult.proposals.length} proposal(s)`);
        this.deferredWork.enqueue(
          (async () => {
            const evaluations = await this.superego.evaluateProposals(taskResult.proposals, this.createLogCallback("SUPEREGO"));
            await this.superego.applyProposals(taskResult.proposals, evaluations);
          })()
        );
      }

      // Enqueue reconsideration as deferred work
      if (success || taskResult.result === "partial") {
        this.deferredWork.enqueue(this.runReconsideration(dispatch, taskResult));
      }

      result = {
        cycleNumber: this.cycleNumber,
        action: "dispatch",
        taskId: dispatch.taskId,
        success,
        summary: taskResult.summary,
      };
    }

    this.eventSink.emit({
      type: "cycle_complete",
      timestamp: this.clock.now().toISOString(),
      data: { cycleNumber: this.cycleNumber, action: result.action },
    });
    this.watchdog?.recordActivity();

    // Record cycle timing to performance.jsonl — best-effort, fire-and-forget
    const cycleDurationMs = this.clock.now().getTime() - cycleStartMs;
    this.performanceMetrics?.recordCycleComplete(
      this.cycleNumber,
      result.action,
      cycleDurationMs,
      result.success,
    ).catch(() => {});

    // Record last cycle diagnostics for health reporting
    this.lastCycleAt = this.clock.now();
    this.lastCycleResult = result.action === "idle" ? "idle" : (result.success ? "success" : "failure");

    // Superego audit — enqueue as deferred work (overlaps with next cycle's dispatch)
    if (this.cycleNumber % this.config.superegoAuditInterval === 0 || this.auditOnNextCycle) {
      this.auditOnNextCycle = false;
      this.deferredWork.enqueue(this.runAudit());
    }



    // Enqueue schedulers as deferred work (overlaps with next cycle's dispatch)
    if (this.schedulerCoordinator) {
      this.deferredWork.enqueue(this.schedulerCoordinator.runDueSchedulers());
    }

    return result;
  }

  // Note: checkAgoraInbox() removed - messages now go directly to CONVERSATION.md
  // and are automatically included in all sessions, so no startup scanning needed

  async runLoop(): Promise<void> {
    this.logger.debug("runLoop() entered");

    // Honor rate limit restored from disk before the previous shutdown.
    if (this.rateLimitUntil !== null) {
      const waitMs = Math.max(0, new Date(this.rateLimitUntil).getTime() - this.clock.now().getTime());
      if (waitMs > 0) {
        this.logger.debug(`runLoop: honoring restored rate limit — waiting ${waitMs}ms until ${this.rateLimitUntil}`);
        this.eventSink.emit({
          type: "idle",
          timestamp: this.clock.now().toISOString(),
          data: { rateLimitUntil: this.rateLimitUntil, waitMs },
        });
        await this.timer.delay(waitMs);
      }
      if (this.rateLimitUntil && new Date(this.rateLimitUntil).getTime() <= this.clock.now().getTime()) {
        this.rateLimitUntil = null;
      }
    }

    while (this.state === LoopState.RUNNING) {
      // Guard: if still rate limited (timer was woken early), re-sleep for remaining duration
      if (this.rateLimitUntil) {
        const remaining = new Date(this.rateLimitUntil).getTime() - this.clock.now().getTime();
        if (remaining > 0) {
          this.logger.debug(`runLoop: still rate limited — re-sleeping ${remaining}ms until ${this.rateLimitUntil}`);
          await this.timer.delay(remaining);
          if (this.rateLimitUntil && new Date(this.rateLimitUntil).getTime() <= this.clock.now().getTime()) {
            this.rateLimitUntil = null;
          }
          continue;
        }
        this.rateLimitUntil = null;
      }

      const cycleResult = await this.runOneCycle();

      if (this.metrics.consecutiveIdleCycles >= this.config.maxConsecutiveIdleCycles) {
        if (this.idleHandler) {
          this.logger.debug(`runLoop: idle threshold reached (${this.metrics.consecutiveIdleCycles}), invoking IdleHandler`);
          const result = await this.idleHandler.handleIdle((role) => this.createLogCallback(role));
          this.logger.debug(`runLoop: IdleHandler result: ${result.action} (goalCount: ${result.goalCount ?? 0})`);
          this.eventSink.emit({
            type: "idle_handler",
            timestamp: this.clock.now().toISOString(),
            data: { action: result.action, goalCount: result.goalCount },
          });
          if (result.action === "plan_created") {
            this.metrics.consecutiveIdleCycles = 0;
            continue;
          }
        }
        this.logger.debug("runLoop: idle threshold exceeded with no plan created — sleeping");
        this.enterSleep();
        break;
      }

      if (this.state !== LoopState.RUNNING) {
        this.logger.debug(`runLoop: exiting — state is ${this.state}`);
        break;
      }

      // Check for rate limit backoff
      const rateLimitReset = parseRateLimitReset(cycleResult.summary, this.clock.now());
      if (rateLimitReset) {
        const waitMs = rateLimitReset.getTime() - this.clock.now().getTime();
        this.rateLimitUntil = rateLimitReset.toISOString();
        this.logger.debug(`runLoop: rate limited — backing off ${waitMs}ms until ${this.rateLimitUntil}`);
        
        // Save state before hibernation
        if (this.rateLimitStateManager) {
          const currentTaskId = cycleResult.action === "dispatch" ? cycleResult.taskId : undefined;
          await this.rateLimitStateManager.saveStateBeforeSleep(rateLimitReset, currentTaskId);
          this.logger.debug(`runLoop: state saved for rate limit hibernation`);
        }
        
        this.eventSink.emit({
          type: "idle",
          timestamp: this.clock.now().toISOString(),
          data: { rateLimitUntil: this.rateLimitUntil, waitMs },
        });
        await this.timer.delay(waitMs);
        // Only clear rate limit if the backoff period has actually elapsed.
        // timer.wake() can resolve early (e.g. from Agora messages or watchdog),
        // and we must NOT clear the rate limit prematurely or we'll waste API calls.
        if (this.rateLimitUntil && new Date(this.rateLimitUntil).getTime() <= this.clock.now().getTime()) {
          this.rateLimitUntil = null;
        }
      } else {
        // Skip the inter-cycle delay when messages are already waiting — process them immediately.
        if (this.pendingMessages.length > 0) {
          this.logger.debug("runLoop: pending messages detected, skipping cycle delay");
        } else {
          this.logger.debug(`runLoop: delaying ${this.config.cycleDelayMs}ms before next cycle`);
          await this.timer.delay(this.config.cycleDelayMs);
        }
      }
    }
    // Drain any remaining deferred work before exiting
    await this.deferredWork.drain();
    this.logger.debug("runLoop() exited");
  }

  setTickDependencies(deps: {
    tickPromptBuilder: TickPromptBuilder;
    sdkSessionFactory: SdkSessionFactory;
  }): void {
    this.tickPromptBuilder = deps.tickPromptBuilder;
    this.sdkSessionFactory = deps.sdkSessionFactory;
  }

  async runOneTick(): Promise<TickResult> {
    if (!this.tickPromptBuilder || !this.sdkSessionFactory) {
      throw new Error("Tick dependencies not configured");
    }

    this.tickNumber++;
    this.tickInProgress = true;
    this.logger.debug(`tick ${this.tickNumber}: starting`);
    this.watchdog?.recordActivity();

    this.eventSink.emit({
      type: "tick_started",
      timestamp: this.clock.now().toISOString(),
      data: { tickNumber: this.tickNumber },
    });

    const systemPrompt = await this.tickPromptBuilder.buildSystemPrompt();
    const initialPrompt = await this.tickPromptBuilder.buildInitialPrompt();

    const sessionConfig: SessionConfig = {
      systemPrompt,
      initialPrompt,
    };

    const sessionManager = new SessionManager(
      this.sdkSessionFactory,
      sessionConfig,
      this.clock,
      this.logger,
      this.createLogCallback("TICK"),
    );

    this.activeSessionManager = sessionManager;

    // Inject any queued messages
    if (this.pendingMessages.length > 0) {
      this.eventSink.emit({
        type: "message_processing_started",
        timestamp: this.clock.now().toISOString(),
        data: { count: this.pendingMessages.length },
      });
      for (const msg of this.pendingMessages) {
        this.logger.debug(`tick ${this.tickNumber}: injecting queued message (${msg.length} chars): ${msgPreview(msg)}`);
        sessionManager.inject(msg);
      }
      this.pendingMessages = [];
    }

    const result = await sessionManager.run();

    this.activeSessionManager = null;

    this.logger.debug(`tick ${this.tickNumber}: done — success=${result.success} duration=${result.durationMs}ms`);

    const tickResult: TickResult = {
      tickNumber: this.tickNumber,
      success: result.success,
      durationMs: result.durationMs,
      error: result.error,
    };

    this.eventSink.emit({
      type: "tick_complete",
      timestamp: this.clock.now().toISOString(),
      data: { tickNumber: this.tickNumber, success: result.success, durationMs: result.durationMs },
    });

    this.tickInProgress = false;
    return tickResult;
  }

  async runTickLoop(): Promise<void> {
    this.logger.debug("runTickLoop() entered");
    while (this.state === LoopState.RUNNING) {
      await this.runOneTick();

      if (this.state !== LoopState.RUNNING) {
        this.logger.debug(`runTickLoop: exiting — state is ${this.state}`);
        break;
      }

      this.logger.debug(`runTickLoop: delaying ${this.config.cycleDelayMs}ms before next tick`);
      await this.timer.delay(this.config.cycleDelayMs);
    }
    await this.deferredWork.drain();
    this.logger.debug("runTickLoop() exited");
  }

  /**
   * Check if a tick or cycle is currently active
   */
  private isTickOrCycleActive(): boolean {
    return this.tickInProgress || this.isProcessing;
  }

  /**
   * Check if conversation session is active
   */
  private isConversationSessionActive(): boolean {
    return this.conversationSessionActive;
  }

  /**
   * Called when conversation session closes (idle timeout or completion)
   */
  private onConversationSessionClosed(): void {
    this.logger.debug("onConversationSessionClosed: conversation session closed");
    this.conversationSessionActive = false;
    this.conversationSessionPromise = null;

    // Process any queued messages if they exist
    if (this.conversationMessageQueue.length > 0) {
      this.logger.debug(`onConversationSessionClosed: ${this.conversationMessageQueue.length} queued messages, will process on next handleUserMessage`);
    }

    // If tick was requested, run it immediately
    if (this.tickRequested && this.state === LoopState.RUNNING) {
      this.logger.debug("onConversationSessionClosed: tickRequested is true, will run tick on next iteration");
      this.tickRequested = false;
      // Note: The tick will run on the next iteration of runTickLoop
    }
  }

  async handleUserMessage(message: string): Promise<void> {
    this.logger.debug(`handleUserMessage: ${message.length} chars — ${msgPreview(message)}`);
    this.watchdog?.recordActivity();

    // Wake loop if sleeping — incoming chat message should restart cycles
    if (this.state === LoopState.SLEEPING) {
      this.logger.debug("handleUserMessage: waking loop from SLEEPING state");
      this.wake();
    }

    // Chat routing: if tick/cycle is active, inject into it
    if (this.isTickOrCycleActive()) {
      this.logger.debug("handleUserMessage: tick/cycle active, injecting message");
      this.injectMessage(message);
      // Emit immediate acknowledgment
      this.eventSink.emit({
        type: "conversation_response",
        timestamp: this.clock.now().toISOString(),
        data: { response: "Message injected into active session" },
      });
      return;
    }

    // If conversation session is active, inject there or queue
    if (this.conversationSessionActive) {
      if (this.launcher) {
        this.logger.debug("handleUserMessage: conversation session active, injecting message");
        this.launcher.inject(message);
        // Emit immediate acknowledgment
        this.eventSink.emit({
          type: "conversation_response",
          timestamp: this.clock.now().toISOString(),
          data: { response: "Message injected into conversation session" },
        });
        return;
      } else {
        // Launcher not available but session active — queue the message
        this.logger.debug("handleUserMessage: conversation session active but launcher unavailable, queuing message");
        this.conversationMessageQueue.push(message);
        this.eventSink.emit({
          type: "conversation_response",
          timestamp: this.clock.now().toISOString(),
          data: { response: "Message queued for conversation session" },
        });
        return;
      }
    }

    // Neither tick/cycle nor conversation session active — start new conversation session (lazy init)
    // Ensure only one conversation session at a time
    if (this.conversationSessionPromise) {
      this.logger.debug("handleUserMessage: conversation session already starting, queuing message");
      this.conversationMessageQueue.push(message);
      await this.conversationSessionPromise;
      return;
    }

    this.logger.debug("handleUserMessage: starting new conversation session");
    this.conversationSessionActive = true;
    
    const sessionPromise = (async () => {
      let timeoutHandle: ReturnType<typeof setTimeout> | null = null;
      try {
        // Process the current message and any queued messages
        const messagesToProcess = [message, ...this.conversationMessageQueue];
        this.conversationMessageQueue = [];

        const maxDuration = this.conversationSessionMaxDurationMs;
        const timeoutPromise: Promise<never> | null = maxDuration > 0
          ? new Promise<never>((_, reject) => {
              timeoutHandle = setTimeout(
                () => reject(new Error(`Conversation session exceeded max duration (${maxDuration}ms)`)),
                maxDuration
              );
            })
          : null;

        for (const msg of messagesToProcess) {
          const respondPromise = this.ego.respondToMessage(
            msg,
            this.createLogCallback("EGO", "conversation"),
            { idleTimeoutMs: this.conversationIdleTimeoutMs }
          );

          const response = timeoutPromise
            ? await Promise.race([respondPromise, timeoutPromise])
            : await respondPromise;

          if (response) {
            await this.checkEndorsement(response);
            this.eventSink.emit({
              type: "conversation_response",
              timestamp: this.clock.now().toISOString(),
              data: { response },
            });
          } else {
            this.logger.debug("handleUserMessage: ego returned no response");
            this.eventSink.emit({
              type: "conversation_response",
              timestamp: this.clock.now().toISOString(),
              data: { error: "No response from session" },
            });
          }
        }
      } catch (err) {
        const errorMsg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`handleUserMessage: error — ${errorMsg}`);
        this.eventSink.emit({
          type: "conversation_response",
          timestamp: this.clock.now().toISOString(),
          data: { error: errorMsg },
        });
      } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        // Session closed (completed or errored)
        this.onConversationSessionClosed();
      }
    })();

    this.conversationSessionPromise = sessionPromise;
    await sessionPromise;
  }

  injectMessage(message: string): boolean {
    this.logger.debug(`injectMessage: ${message.length} chars — ${msgPreview(message)}`);

    this.eventSink.emit({
      type: "message_injected",
      timestamp: this.clock.now().toISOString(),
      data: { message },
    });

    // Tick mode: forward to active session manager
    if (this.activeSessionManager?.isActive()) {
      this.activeSessionManager.inject(message);
      return true;
    }

    // Cycle mode: forward to launcher's active session (via streamInput)
    if (this.launcher?.isActive()) {
      this.launcher.inject(message);
      return true;
    }

    // No active session — queue for next tick/cycle and wake the timer for immediate pickup
    this.logger.debug("injectMessage: no active session, queuing and waking timer");
    this.pendingMessages.push(message);
    this.timer.wake();
    return false;
  }

  private transition(to: LoopState): void {
    const from = this.state;
    this.state = to;
    this.logger.debug(`state: ${from} → ${to}`);
    this.eventSink.emit({
      type: "state_changed",
      timestamp: this.clock.now().toISOString(),
      data: { from, to },
    });
  }

  private enterSleep(): void {
    this.logger.debug("enterSleep() — transitioning to SLEEPING state");
    this.transition(LoopState.SLEEPING);
    this.onSleepEnter?.().catch((err) => {
      this.logger.debug(`enterSleep: onSleepEnter failed — ${err instanceof Error ? err.message : String(err)}`);
    });
  }

  private createLogCallback(role: string, source: "cycle" | "conversation" = "cycle"): (entry: ProcessLogEntry) => void {
    return (entry) => {
      this.eventSink.emit({
        type: "process_output",
        timestamp: this.clock.now().toISOString(),
        data: { role, cycleNumber: this.cycleNumber, entry, source },
      });
      // Feed entries to endorsement interceptor for Layer 3 detection
      if (role === "EGO" && this.endorsementInterceptor) {
        this.endorsementInterceptor.onLogEntry(entry);
      }
    };
  }

  private async checkEndorsement(rawOutput: string): Promise<void> {
    if (!this.endorsementInterceptor) return;
    try {
      const result = await this.endorsementInterceptor.evaluateOutput(rawOutput);
      if (result.triggered && result.injectionMessage) {
        this.logger.debug(`endorsement: Layer ${result.layer} triggered — ${result.verdict} (action: "${result.action}")`);
        this.injectMessage(result.injectionMessage);
      } else if (result.triggered && result.layer === 3) {
        this.logger.debug(`endorsement: Layer 3 detected external action — ${result.action} (log only)`);
      }
    } catch (err) {
      this.logger.debug(`endorsement: check failed — ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      this.endorsementInterceptor.reset();
    }
  }

  private async runAudit(): Promise<void> {
    this.logger.debug(`audit: starting (cycle ${this.cycleNumber})`);
    this.metrics.superegoAudits++;
    try {
      const report = await this.superego.audit(
        this.createLogCallback("SUPEREGO"),
        this.cycleNumber,
        this.findingTracker
      );
      // Audit results are emitted via eventSink (below) and available in systemd logs
      // No need to log to PROGRESS.md as it would pollute the high-level summary file
      this.logger.debug(`audit: complete — ${report.summary}`);
      await this.reportStore?.save(report as Record<string, unknown>);
      this.metrics.consecutiveAuditFailures = 0;
    } catch (err) {
      this.metrics.consecutiveAuditFailures++;
      const msg = `audit failed (${this.metrics.consecutiveAuditFailures} consecutive): ${err instanceof Error ? err.message : String(err)}`;
      if (this.metrics.consecutiveAuditFailures >= 3) {
        this.logger.error(`[orchestrator] ${msg} — check logs, Superego may need attention`);
      } else {
        this.logger.warn(`[orchestrator] ${msg}`);
      }
    } finally {
      if (this.findingTrackerSave) {
        try {
          await this.findingTrackerSave();
        } catch (err) {
          this.logger.debug(`audit: failed to persist finding tracker — ${err instanceof Error ? err.message : String(err)}`);
        }
      }
    }
    this.eventSink.emit({
      type: "audit_complete",
      timestamp: this.clock.now().toISOString(),
      data: { cycleNumber: this.cycleNumber },
    });
  }

  private async recordDriveRatingIfApplicable(description: string, taskResult: TaskResult): Promise<void> {
    if (!this.driveQualityTracker) return;

    const match = description.match(/\[ID-generated (\d{4}-\d{2}-\d{2})\]/);
    if (!match) return;

    const generatedAt = match[1];
    const rating = Subconscious.computeDriveRating(taskResult);
    const category = DriveQualityTracker.inferCategory(description);

    try {
      await this.driveQualityTracker.recordRating({
        task: description,
        generatedAt,
        completedAt: this.clock.now().toISOString(),
        rating,
        category,
      });
      this.logger.debug(`drive-quality: recorded rating ${rating}/10 for "${category}" task`);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`drive-quality: failed to record rating — ${msg}`);
    }
  }

  private async sendAgoraReplies(replies: AgoraReply[]): Promise<void> {
    if (!this.agoraService) return;

    for (const reply of replies) {
      try {
        const result = await this.agoraService.sendMessage({
          peerName: reply.peerName,
          type: "publish",
          payload: { text: reply.text },
          inReplyTo: reply.inReplyTo,
        });
        if (result.ok) {
          this.logger.debug(`agoraReplies: sent to ${reply.peerName} (status=${result.status})`);
        } else {
          this.logger.debug(`agoraReplies: failed to send to ${reply.peerName} — ${result.error ?? "unknown error"} (status=${result.status})`);
        }
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.debug(`agoraReplies: error sending to ${reply.peerName} — ${msg}`);
      }
    }
  }

  private async runReconsideration(
    dispatch: { taskId: string; description: string },
    taskResult: TaskResult
  ): Promise<void> {
    this.logger.debug(`reconsideration: evaluating outcome for task "${dispatch.taskId}" (cycle ${this.cycleNumber})`);
    try {
      let evaluation: OutcomeEvaluation;

      if (!this.config.evaluateOutcomeEnabled) {
        // Heuristic path: use computeDriveRating() without spawning an LLM session
        const driveRating = Subconscious.computeDriveRating(taskResult);
        const qualityScore = driveRating * 10; // scale 0-10 → 0-100

        if (qualityScore >= this.config.evaluateOutcomeQualityThreshold) {
          // Score is good enough — use heuristic result directly
          const outcomeMatchesIntent = taskResult.result !== "failure";
          // needsReassessment: only if quality is catastrophically 0 (threshold can't be ≤0 in practice)
          const needsReassessment = qualityScore === 0;
          this.logger.debug(`reconsideration: heuristic score ${qualityScore}/100 — skipping LLM evaluation`);
          evaluation = { outcomeMatchesIntent, qualityScore, issuesFound: [], recommendedActions: [], needsReassessment };
        } else {
          // Score below threshold — fall back to LLM for safety
          this.logger.debug(`reconsideration: heuristic score ${qualityScore}/100 below threshold — falling back to LLM`);
          evaluation = await this.subconscious.evaluateOutcome(
            { taskId: dispatch.taskId, description: dispatch.description },
            taskResult,
            this.createLogCallback("SUBCONSCIOUS")
          );
        }
      } else {
        // LLM evaluation enabled — original behavior
        evaluation = await this.subconscious.evaluateOutcome(
          { taskId: dispatch.taskId, description: dispatch.description },
          taskResult,
          this.createLogCallback("SUBCONSCIOUS")
        );
      }

      this.logger.debug(
        `reconsideration: complete — outcome matches intent: ${evaluation.outcomeMatchesIntent}, ` +
        `quality: ${evaluation.qualityScore}/100, needs reassessment: ${evaluation.needsReassessment}`
      );

      // Reconsideration results are emitted via eventSink (below) and available in systemd logs
      // No need to log to PROGRESS.md as it would pollute the high-level summary file

      this.eventSink.emit({
        type: "reconsideration_complete",
        timestamp: this.clock.now().toISOString(),
        data: {
          cycleNumber: this.cycleNumber,
          taskId: dispatch.taskId,
          outcomeMatchesIntent: evaluation.outcomeMatchesIntent,
          qualityScore: evaluation.qualityScore,
          issuesCount: evaluation.issuesFound.length,
          recommendedActionsCount: evaluation.recommendedActions.length,
          needsReassessment: evaluation.needsReassessment,
        },
      });

      // If quality is very low or needs reassessment, trigger audit on next cycle
      if (evaluation.qualityScore < 50 || evaluation.needsReassessment) {
        this.logger.debug(`reconsideration: low quality or reassessment needed — scheduling audit`);
        this.auditOnNextCycle = true;
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`reconsideration: unexpected error — ${errorMsg}`);
      this.eventSink.emit({
        type: "reconsideration_complete",
        timestamp: this.clock.now().toISOString(),
        data: {
          cycleNumber: this.cycleNumber,
          taskId: dispatch.taskId,
          error: errorMsg,
        },
      });
    }
  }
}
