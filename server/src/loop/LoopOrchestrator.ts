import { Ego } from "../agents/roles/Ego";
import { Subconscious, TaskResult, OutcomeEvaluation } from "../agents/roles/Subconscious";
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
import { BackupScheduler } from "./BackupScheduler";
import { HealthCheckScheduler } from "./HealthCheckScheduler";
import { EmailScheduler } from "./EmailScheduler";
import { MetricsScheduler } from "./MetricsScheduler";
import { ValidationScheduler } from "./ValidationScheduler";
import { LoopWatchdog } from "./LoopWatchdog";
import { SuperegoFindingTracker } from "../agents/roles/SuperegoFindingTracker";
import { IMessageInjector } from "./IMessageInjector";
import { GovernanceReportStore } from "../evaluation/GovernanceReportStore";
import { DriveQualityTracker } from "../evaluation/DriveQualityTracker";

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

  // Backup scheduler
  private backupScheduler: BackupScheduler | null = null;

  // Health check scheduler
  private healthCheckScheduler: HealthCheckScheduler | null = null;

  // Email scheduler
  private emailScheduler: EmailScheduler | null = null;

  // Metrics scheduler
  private metricsScheduler: MetricsScheduler | null = null;

  // Validation scheduler
  private validationScheduler: ValidationScheduler | null = null;

  // Watchdog — detects stalls and injects gentle reminders
  private watchdog: LoopWatchdog | null = null;

  // Rate limit state manager for hibernation context
  private rateLimitStateManager: RateLimitStateManager | null = null;

  // Governance report store for persisting audit reports
  private reportStore: GovernanceReportStore | null = null;

  // Drive quality tracker for Id learning loop
  private driveQualityTracker: DriveQualityTracker | null = null;

  // SUPEREGO finding tracker for recurring finding escalation
  private findingTracker: SuperegoFindingTracker = new SuperegoFindingTracker();

  // Optional callback to persist finding tracker state after each audit
  private findingTrackerSave: (() => Promise<void>) | null = null;

  // Tick mode
  private tickPromptBuilder: TickPromptBuilder | null = null;
  private sdkSessionFactory: SdkSessionFactory | null = null;
  private activeSessionManager: SessionManager | null = null;
  private tickNumber = 0;
  private pendingMessages: string[] = [];

  // Tick state for deferred tick logic
  private tickRequested = false;
  private tickInProgress = false;

  // Conversation session gate
  private conversationSessionActive = false;
  private conversationSessionPromise: Promise<void> | null = null;
  private conversationMessageQueue: string[] = [];
  private readonly conversationIdleTimeoutMs: number;

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
    findingTrackerSave?: () => Promise<void>
  ) {
    this.conversationIdleTimeoutMs = conversationIdleTimeoutMs ?? 60_000; // Default 60s
    if (findingTracker) {
      this.findingTracker = findingTracker;
    }
    this.findingTrackerSave = findingTrackerSave ?? null;
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

  stop(): void {
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
    if (this.shutdownFn) {
      this.shutdownFn(0); // Exit with code 0 (graceful shutdown)
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
   * In cycle mode: serves as a reminder alongside [UNPROCESSED] markers in CONVERSATION.md.
   */
  queueStartupMessage(message: string): void {
    this.pendingMessages.push(message);
    this.logger.debug(`queueStartupMessage: queued startup message (${message.length} chars)`);
  }

  setShutdown(fn: (exitCode: number) => void): void {
    this.shutdownFn = fn;
  }

  setBackupScheduler(scheduler: BackupScheduler): void {
    this.backupScheduler = scheduler;
  }

  setHealthCheckScheduler(scheduler: HealthCheckScheduler): void {
    this.healthCheckScheduler = scheduler;
  }

  setEmailScheduler(scheduler: EmailScheduler): void {
    this.emailScheduler = scheduler;
  }

  setMetricsScheduler(scheduler: MetricsScheduler): void {
    this.metricsScheduler = scheduler;
  }

  setValidationScheduler(scheduler: ValidationScheduler): void {
    this.validationScheduler = scheduler;
  }

  setWatchdog(watchdog: LoopWatchdog): void {
    this.watchdog = watchdog;
  }

  // Note: setAgoraInboxManager() removed - messages now go directly to CONVERSATION.md

  setRateLimitStateManager(manager: RateLimitStateManager): void {
    this.rateLimitStateManager = manager;
  }

  setReportStore(store: GovernanceReportStore): void {
    this.reportStore = store;
  }

  setDriveQualityTracker(tracker: DriveQualityTracker): void {
    this.driveQualityTracker = tracker;
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

    // Gate cycle while conversation session is active
    if (this.conversationSessionActive) {
      this.logger.debug("runOneCycle() deferred — conversation session active");
      this.tickRequested = true; // Use same flag for cycle mode
      return {
        cycleNumber: this.cycleNumber,
        action: "idle",
        success: true,
        summary: "Deferred due to active conversation session",
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

    const dispatch = await this.ego.dispatchNext();

    let result: CycleResult;

    if (!dispatch) {
      this.metrics.idleCycles++;
      this.metrics.consecutiveIdleCycles++;

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

      const taskResult = await this.subconscious.execute({
        taskId: dispatch.taskId,
        description: dispatch.description,
      }, this.createLogCallback("SUBCONSCIOUS"));

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

      // Drive learning: if task was Id-generated, record a quality rating for future drive improvement
      await this.recordDriveRatingIfApplicable(dispatch.description, taskResult);

      if (taskResult.proposals.length > 0) {
        this.logger.debug(`cycle ${this.cycleNumber}: evaluating ${taskResult.proposals.length} proposal(s)`);
        const evaluations = await this.superego.evaluateProposals(taskResult.proposals, this.createLogCallback("SUPEREGO"));
        await this.superego.applyProposals(taskResult.proposals, evaluations);
      }

      // Reconsideration phase: evaluate outcome quality and need for reassessment
      if (success || taskResult.result === "partial") {
        await this.runReconsideration(dispatch, taskResult);
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

    // Superego audit scheduling
    if (this.cycleNumber % this.config.superegoAuditInterval === 0 || this.auditOnNextCycle) {
      this.auditOnNextCycle = false;
      await this.runAudit();
    }



    // Backup scheduling
    if (this.backupScheduler && await this.backupScheduler.shouldRunBackup()) {
      await this.runScheduledBackup();
    }

    // Health check scheduling
    if (this.healthCheckScheduler && this.healthCheckScheduler.shouldRunCheck()) {
      await this.runScheduledHealthCheck();
    }

    // Email scheduling
    if (this.emailScheduler && await this.emailScheduler.shouldRunEmail()) {
      await this.runScheduledEmail();
    }

    // Metrics scheduling
    if (this.metricsScheduler && await this.metricsScheduler.shouldRunMetrics()) {
      await this.runScheduledMetrics();
    }

    // Validation scheduling
    if (this.validationScheduler && await this.validationScheduler.shouldRunValidation()) {
      await this.runScheduledValidation();
    }

    return result;
  }

  // Note: checkAgoraInbox() removed - messages now go directly to CONVERSATION.md
  // and are automatically included in all sessions, so no startup scanning needed

  async runLoop(): Promise<void> {
    this.logger.debug("runLoop() entered");
    while (this.state === LoopState.RUNNING) {
      const cycleResult = await this.runOneCycle();

      // If cycle was deferred, wait for conversation session to close
      if (cycleResult.summary === "Deferred due to active conversation session") {
        this.logger.debug("runLoop: cycle deferred, waiting for conversation session to close");
        if (this.conversationSessionPromise) {
          await this.conversationSessionPromise;
          // If tickRequested, run cycle immediately
          if (this.tickRequested && !this.conversationSessionActive) {
            this.tickRequested = false;
            continue; // Run cycle immediately without delay
          }
        }
        // If still deferred, wait a bit before checking again
        await this.timer.delay(1000);
        continue;
      }

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
        this.logger.debug("runLoop: stopping — idle threshold exceeded with no plan created");
        if (this.config.idleSleepEnabled) {
          this.enterSleep();
        } else {
          this.stop();
        }
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
        this.rateLimitUntil = null;
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
    // Gate tick while conversation session is active (check before dependencies)
    if (this.conversationSessionActive) {
      this.logger.debug(`tick ${this.tickNumber + 1}: deferred — conversation session active`);
      this.tickRequested = true;
      // Return a "deferred" result
      return {
        tickNumber: this.tickNumber,
        success: true,
        durationMs: 0,
        error: "Deferred due to active conversation session",
      };
    }

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
    for (const msg of this.pendingMessages) {
      this.logger.debug(`tick ${this.tickNumber}: injecting queued message (${msg.length} chars): ${msg}`);
      sessionManager.inject(msg);
    }
    this.pendingMessages = [];

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
      const result = await this.runOneTick();

      // If tick was deferred, don't delay — wait for conversation session to close
      if (result.error === "Deferred due to active conversation session") {
        this.logger.debug("runTickLoop: tick deferred, waiting for conversation session to close");
        // Wait for conversation session promise if it exists
        if (this.conversationSessionPromise) {
          await this.conversationSessionPromise;
          // If tickRequested, run it immediately
          if (this.tickRequested && !this.conversationSessionActive) {
            this.tickRequested = false;
            continue; // Run tick immediately without delay
          }
        }
        // If still deferred, wait a bit before checking again
        await this.timer.delay(1000);
        continue;
      }

      if (this.state !== LoopState.RUNNING) {
        this.logger.debug(`runTickLoop: exiting — state is ${this.state}`);
        break;
      }

      this.logger.debug(`runTickLoop: delaying ${this.config.cycleDelayMs}ms before next tick`);
      await this.timer.delay(this.config.cycleDelayMs);
    }
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
    this.logger.debug(`handleUserMessage: "${message}"`);
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
      try {
        // Process the current message and any queued messages
        const messagesToProcess = [message, ...this.conversationMessageQueue];
        this.conversationMessageQueue = [];

        for (const msg of messagesToProcess) {
          const response = await this.ego.respondToMessage(
            msg,
            this.createLogCallback("EGO", "conversation"),
            { idleTimeoutMs: this.conversationIdleTimeoutMs }
          );

          if (response) {
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
        // Session closed (completed or errored)
        this.onConversationSessionClosed();
      }
    })();

    this.conversationSessionPromise = sessionPromise;
    await sessionPromise;
  }

  injectMessage(message: string): boolean {
    this.logger.debug(`injectMessage: "${message}"`);

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
    };
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
    } catch (err) {
      this.logger.debug(`audit: failed — ${err instanceof Error ? err.message : String(err)}`);
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

  private async runScheduledBackup(): Promise<void> {
    this.logger.debug(`backup: starting scheduled backup (cycle ${this.cycleNumber})`);
    try {
      const result = await this.backupScheduler!.runBackup();
      if (result.success) {
        this.logger.debug(`backup: success — ${result.backupPath} (verified: ${result.verification?.valid ?? false})`);
        this.eventSink.emit({
          type: "backup_complete",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: true,
            backupPath: result.backupPath,
            verified: result.verification?.valid ?? false,
            checksum: result.verification?.checksum,
            sizeBytes: result.verification?.sizeBytes,
          },
        });
      } else {
        this.logger.debug(`backup: failed — ${result.error}`);
        this.eventSink.emit({
          type: "backup_complete",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: false,
            error: result.error,
          },
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`backup: unexpected error — ${errorMsg}`);
      this.eventSink.emit({
        type: "backup_complete",
        timestamp: this.clock.now().toISOString(),
        data: {
          cycleNumber: this.cycleNumber,
          success: false,
          error: errorMsg,
        },
      });
    }
  }

  private async runScheduledHealthCheck(): Promise<void> {
    this.logger.debug(`health_check: starting scheduled check (cycle ${this.cycleNumber})`);
    try {
      const result = await this.healthCheckScheduler!.runCheck();
      if (result.success && result.result) {
        this.logger.debug(`health_check: complete — overall: ${result.result.overall}`);
        this.eventSink.emit({
          type: "health_check_complete",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: true,
            overall: result.result.overall,
            drift: {
              score: result.result.drift.score,
              findings: result.result.drift.findings.length,
            },
            consistency: {
              consistent: result.result.consistency.inconsistencies.length === 0,
              issues: result.result.consistency.inconsistencies.length,
            },
            security: {
              compliant: result.result.security.compliant,
              issues: result.result.security.issues.length,
            },
            planQuality: {
              score: result.result.planQuality.score,
              findings: result.result.planQuality.findings.length,
            },
            reasoning: {
              valid: result.result.reasoning.valid,
              issues: result.result.reasoning.issues.length,
            },
          },
        });
      } else {
        this.logger.debug(`health_check: failed — ${result.error}`);
        this.eventSink.emit({
          type: "health_check_complete",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: false,
            error: result.error,
          },
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`health_check: unexpected error — ${errorMsg}`);
      this.eventSink.emit({
        type: "health_check_complete",
        timestamp: this.clock.now().toISOString(),
        data: {
          cycleNumber: this.cycleNumber,
          success: false,
          error: errorMsg,
        },
      });
    }
  }

  private async runScheduledEmail(): Promise<void> {
    this.logger.debug(`email: starting scheduled email (cycle ${this.cycleNumber})`);
    try {
      const result = await this.emailScheduler!.runEmail();
      if (result.success && result.content) {
        this.logger.debug(`email: success — ${result.content.subject}`);
        this.eventSink.emit({
          type: "email_sent",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: true,
            subject: result.content.subject,
            bodyPreview: result.content.body.substring(0, 100),
          },
        });
      } else {
        this.logger.debug(`email: failed — ${result.error}`);
        this.eventSink.emit({
          type: "email_sent",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: false,
            error: result.error,
          },
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`email: unexpected error — ${errorMsg}`);
      this.eventSink.emit({
        type: "email_sent",
        timestamp: this.clock.now().toISOString(),
        data: {
          cycleNumber: this.cycleNumber,
          success: false,
          error: errorMsg,
        },
      });
    }
  }

  private async runScheduledMetrics(): Promise<void> {
    this.logger.debug(`metrics: starting scheduled metrics collection (cycle ${this.cycleNumber})`);
    try {
      const result = await this.metricsScheduler!.runMetrics();
      if (result.success) {
        this.logger.debug(`metrics: success — collected: ${JSON.stringify(result.collected)}`);
        this.eventSink.emit({
          type: "metrics_collected",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: true,
            collected: result.collected,
          },
        });
      } else {
        this.logger.debug(`metrics: failed — ${result.error}`);
        this.eventSink.emit({
          type: "metrics_collected",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: false,
            error: result.error,
          },
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`metrics: unexpected error — ${errorMsg}`);
      this.eventSink.emit({
        type: "metrics_collected",
        timestamp: this.clock.now().toISOString(),
        data: {
          cycleNumber: this.cycleNumber,
          success: false,
          error: errorMsg,
        },
      });
    }
  }

  private async runScheduledValidation(): Promise<void> {
    this.logger.debug(`validation: starting scheduled substrate validation (cycle ${this.cycleNumber})`);
    try {
      const result = await this.validationScheduler!.runValidation();
      if (result.success && result.report) {
        const { brokenReferences, orphanedFiles, staleFiles } = result.report;
        this.logger.debug(
          `validation: success — ${brokenReferences.length} broken refs, ` +
          `${orphanedFiles.length} orphaned files, ${staleFiles.length} stale files`
        );
        this.eventSink.emit({
          type: "validation_complete",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: true,
            brokenReferences: brokenReferences.length,
            orphanedFiles: orphanedFiles.length,
            staleFiles: staleFiles.length,
          },
        });
      } else {
        this.logger.debug(`validation: failed — ${result.error}`);
        this.eventSink.emit({
          type: "validation_complete",
          timestamp: this.clock.now().toISOString(),
          data: {
            cycleNumber: this.cycleNumber,
            success: false,
            error: result.error,
          },
        });
      }
    } catch (err) {
      const errorMsg = err instanceof Error ? err.message : String(err);
      this.logger.debug(`validation: unexpected error — ${errorMsg}`);
      this.eventSink.emit({
        type: "validation_complete",
        timestamp: this.clock.now().toISOString(),
        data: {
          cycleNumber: this.cycleNumber,
          success: false,
          error: errorMsg,
        },
      });
    }
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
