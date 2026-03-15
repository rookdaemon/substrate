import * as path from "path";
import * as nodeFs from "node:fs";
import { NodeTimer } from "./NodeTimer";
import { LoopOrchestrator } from "./LoopOrchestrator";
import { RateLimitStateManager } from "./RateLimitStateManager";
import { IdleHandler } from "./IdleHandler";
import { LoopHttpServer } from "./LoopHttpServer";
import { LoopWebSocketServer } from "./LoopWebSocketServer";
import { defaultLoopConfig } from "./types";
import { HealthCheck } from "../evaluation/HealthCheck";
import { MetricsStore } from "../evaluation/MetricsStore";
import { GovernanceReportStore } from "../evaluation/GovernanceReportStore";
import { CanaryLogger } from "../evaluation/CanaryLogger";
import { TickPromptBuilder } from "../session/TickPromptBuilder";
import { createSdkSessionFactory } from "../session/SdkSessionAdapter";
import { BackupScheduler } from "./BackupScheduler";
import { NodeProcessRunner } from "../agents/claude/NodeProcessRunner";
import { HealthCheckScheduler } from "./HealthCheckScheduler";
import { EmailScheduler } from "./EmailScheduler";
import { MetricsScheduler } from "./MetricsScheduler";
import { ValidationScheduler } from "./ValidationScheduler";
import { IScheduler } from "./IScheduler";
import { SchedulerCoordinator } from "./SchedulerCoordinator";
import { HeartbeatScheduler } from "./HeartbeatScheduler";
import { AgoraPeerMessageCondition } from "./AgoraPeerMessageCondition";
import { LoopStartedCondition } from "./LoopStartedCondition";
import { PeerAvailabilityCondition } from "./PeerAvailabilityCondition";
import type { IConditionEvaluator } from "./IConditionEvaluator";
import { SelfImprovementMetricsCollector } from "../evaluation/SelfImprovementMetrics";
import { PerformanceMetrics } from "../evaluation/PerformanceMetrics";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import type { AgoraService } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import { getIgnoredPeersPath, getSeenKeysPath } from "@rookdaemon/agora";
import { LoopWatchdog } from "./LoopWatchdog";
import { SleepWakeTimer } from "./SleepWakeTimer";
import { parseHeartbeat, computeNextWakeTime } from "./HeartbeatParser";
import { getAppPaths } from "../paths";
import { EndorsementInterceptor, EndorsementScreener } from "../agents/endorsement";
import { TinyBus, SessionInjectionProvider, ChatMessageProvider, type Message } from "../tinybus";
import { ConversationProvider } from "../tinybus/providers/ConversationProvider";
import { AgoraMessageHandler } from "../agora/AgoraMessageHandler";
import { AgoraOutboundProvider } from "../agora/AgoraOutboundProvider";
import { IAgoraService } from "../agora/IAgoraService";
import { buildPeerReferenceDirectory } from "../agora/utils";
import { FlashGate } from "../gates/FlashGate";
import { FileWatcher } from "../substrate/watcher/FileWatcher";
import { SubstrateFileType } from "../substrate/types";
import { PeerAvailabilityMonitor } from "./PeerAvailabilityMonitor";
import { CodeDispatcher } from "../code-dispatch/CodeDispatcher";
import { ClaudeCliBackend } from "../code-dispatch/ClaudeCliBackend";
import { CopilotBackend } from "../code-dispatch/CopilotBackend";
import { GeminiCliBackend } from "../code-dispatch/GeminiCliBackend";
import type { BackendType } from "../code-dispatch/types";
import type { ICodeBackend } from "../code-dispatch/ICodeBackend";
import type { SdkQueryFn } from "../agents/claude/AgentSdkLauncher";
import type { ApplicationConfig } from "./applicationTypes";
import type { SubstrateLayerResult } from "./createSubstrateLayer";
import type { AgentLayerResult } from "./createAgentLayer";

export interface LoopLayerResult {
  orchestrator: LoopOrchestrator;
  httpServer: LoopHttpServer;
  wsServer: LoopWebSocketServer;
  fileWatcher: FileWatcher;
  tinyBus: TinyBus;
  mode: "cycle" | "tick";
}

/**
 * Creates all loop-layer objects: orchestrator, HTTP/WS servers, file watcher,
 * TinyBus, Agora integration, all schedulers, watchdog, and startup scan.
 * Wires them together and returns the assembled loop layer.
 */
export async function createLoopLayer(
  config: ApplicationConfig,
  sdkQuery: SdkQueryFn,
  substrate: SubstrateLayerResult,
  agents: AgentLayerResult,
): Promise<LoopLayerResult> {
  const { fs, clock, substrateConfig, reader, appendWriter, lock, writer, logger, metaManager } = substrate;
  const { ego, subconscious, superego, id, conversationManager, launcher, gatedLauncher,
    taskMetrics, sizeTracker, delegationTracker, driveQualityTracker, vertexSubprocessLauncher } = agents;

  // Loop layer — build httpServer first for the underlying http.Server,
  // then wsServer, then orchestrator, then wire orchestrator back into httpServer
  const loopConfig = defaultLoopConfig({
    cycleDelayMs: config.cycleDelayMs,
    superegoAuditInterval: config.superegoAuditInterval,
    maxConsecutiveIdleCycles: config.idleSleepConfig?.enabled
      ? config.idleSleepConfig.idleCyclesBeforeSleep
      : config.maxConsecutiveIdleCycles,
    idleSleepEnabled: config.idleSleepConfig?.enabled ?? false,
    evaluateOutcomeEnabled: config.evaluateOutcome?.enabled ?? false,
    evaluateOutcomeQualityThreshold: config.evaluateOutcome?.qualityThreshold ?? 85,
  });

  const httpServer = new LoopHttpServer();
  const wsServer = new LoopWebSocketServer(httpServer.getServer());
  const timer = new NodeTimer();

  // File watcher for substrate files - emits file_changed events via websocket
  const fileWatcher = new FileWatcher(substrateConfig, wsServer, clock);

  // Create TinyBus instance for message routing (logger injected for #223 observability)
  const tinyBus = new TinyBus(undefined, logger);

  // Agora service for agent-to-agent communication
  let agoraService: IAgoraService | null = null;
  let agoraMessageHandler: AgoraMessageHandler | null = null;
  let agoraOutboundProvider: AgoraOutboundProvider | null = null;
  let agoraConfig: Awaited<ReturnType<typeof AgoraService.loadConfig>> | null = null;
  try {
    const agora = await import("@rookdaemon/agora");
    agoraConfig = await agora.AgoraService.loadConfig();
    // AgoraService v0.4.5+ receives onRelayMessage at construction time.
    // The closure captures the outer `agoraMessageHandler` binding; by the time
    // any relay message arrives (after connectRelay below), it will be set.
    agoraService = new agora.AgoraService(
      agoraConfig,
      async (envelope: Envelope, from: string) => {
        if (!agoraMessageHandler) return;
        try {
          logger.debug(`[AGORA] Relay message received: envelopeId=${envelope.id} type=${envelope.type} from=${from}`);
          const verifyResult = agora.verifyEnvelope(envelope);
          if (!verifyResult.valid) {
            logger.debug(`[AGORA] Rejected relay message: ${verifyResult.reason ?? "invalid signature"} envelopeId=${envelope.id}`);
            return;
          }
          logger.debug(`[AGORA] Relay message verified: envelopeId=${envelope.id}`);
          await agoraMessageHandler.processEnvelope(envelope, "relay");
          logger.debug(`[AGORA] Relay message processed: envelopeId=${envelope.id}`);
        } catch (err) {
          logger.debug(`[AGORA] Failed to process relay message: ${err instanceof Error ? err.message : String(err)}`);
        }
      },
      logger,
    ) as unknown as IAgoraService;
    // Patch getSelfIdentity — not present on upstream AgoraService
    const capturedConfig = agoraConfig;
    (agoraService as Record<string, unknown>).getSelfIdentity = () =>
      capturedConfig ? { publicKey: capturedConfig.identity.publicKey, name: capturedConfig.identity.name } : undefined;
  } catch (err) {
    // If Agora config doesn't exist, log and continue without Agora capability
    logger.debug("Agora not configured: " + (err instanceof Error ? err.message : String(err)));
  }

  const canaryLogPath = path.resolve(config.substratePath, "..", "data", "canary-log.jsonl");
  const canaryLogger = new CanaryLogger(fs, canaryLogPath);

  // Determine the effective launcher name for canary observability records
  const idLauncherName =
    config.idLauncher === "vertex" && agents.vertexSubprocessLauncher
      ? "vertex"
      : config.idLauncher === "ollama"
      ? "ollama"
      : config.idLauncher === "groq"
      ? "groq"
      : config.sessionLauncher ?? "claude";

  const idleHandler = new IdleHandler(id, superego, ego, clock, logger, canaryLogger, idLauncherName);

  const orchestrator = new LoopOrchestrator(
    ego, subconscious, superego, id,
    appendWriter, clock, timer, wsServer, loopConfig,
    logger, idleHandler,
    config.conversationIdleTimeoutMs,
    substrate.findingTracker,
    substrate.findingTrackerSave,
    config.conversationSessionMaxDurationMs,
    config.substratePath,
    fs,
  );

  // Wire up sleep/wake infrastructure
  const mode = config.mode ?? "cycle";
  orchestrator.setResumeLoopFn(() => {
    if (mode === "tick") {
      return orchestrator.runTickLoop();
    } else {
      return orchestrator.runLoop();
    }
  });

  // Sleep state persistence — write flag file on sleep, clear on wake
  if (config.idleSleepConfig?.enabled) {
    const sleepStatePath = path.resolve(config.substratePath, "..", ".sleep-state");
    orchestrator.setSleepCallbacks(
      async () => {
        try { await fs.writeFile(sleepStatePath, "sleeping"); } catch { /* ignore */ }
      },
      async () => {
        try { await fs.writeFile(sleepStatePath, "awake"); } catch { /* ignore */ }
      }
    );

    // Heartbeat-driven wake timer — wakes the loop at the next scheduled HEARTBEAT entry
    const heartbeatPath = path.join(config.substratePath, "HEARTBEAT.md");
    const sleepWakeTimer = new SleepWakeTimer(logger);
    orchestrator.setSleepWakeTimer(sleepWakeTimer, () => {
      try {
        const content = nodeFs.readFileSync(heartbeatPath, "utf-8");
        const entries = parseHeartbeat(content);
        return computeNextWakeTime(entries, clock.now());
      } catch {
        return null; // HEARTBEAT.md absent or unreadable
      }
    });

    // Check for persisted sleep state from before restart
    try {
      const sleepContent = await fs.readFile(sleepStatePath);
      if (sleepContent.trim() === "sleeping") {
        orchestrator.initializeSleeping();
        logger.debug("createApplication: resumed in SLEEPING state (persisted from before restart)");
      }
    } catch {
      // Flag file doesn't exist — not sleeping
    }
  }

  // Create AgoraMessageHandler now that orchestrator exists
  if (agoraService && agoraConfig) {
    const rateLimitConfig = config.agora?.security?.perSenderRateLimit ?? {
      enabled: true,
      maxMessages: 10,
      windowMs: 60000,
    };
    const unknownSenderPolicy = config.agora?.security?.unknownSenderPolicy ?? 'quarantine';

    // Wire F2 FlashGate if VertexSessionLauncher is available
    const flashGate = vertexSubprocessLauncher
      ? new FlashGate(vertexSubprocessLauncher, clock, logger, config.vertexModel)
      : null;
    if (flashGate) {
      logger.debug("[AGORA] F2 FlashGate enabled (VertexSessionLauncher wired)");
    } else {
      logger.debug("[AGORA] F2 FlashGate disabled (no VertexSessionLauncher configured)");
    }

    agoraMessageHandler = new AgoraMessageHandler(
      agoraService,
      conversationManager,
      orchestrator, // implements IMessageInjector
      wsServer,
      clock,
      () => orchestrator.getState(), // getState callback
      () => orchestrator.getRateLimitUntil() !== null, // isRateLimited callback
      logger,
      unknownSenderPolicy,
      rateLimitConfig,
      () => { // wakeLoop callback — wake orchestrator if sleeping on incoming Agora message
        try { orchestrator.wake(); } catch { /* not sleeping */ }
      },
      getIgnoredPeersPath(),
      getSeenKeysPath(),
      flashGate, // F2 gate — null when VertexSessionLauncher is unavailable
    );

    // NOTE: connectRelay is intentionally deferred to after all startup state has been
    // restored (dedup state, rate-limit state, sleep state, orchestrator deps).
    // See the connectRelay call near the end of createLoopLayer for details.
  }

  // Set up TinyBus providers
  // 1. Session injection provider - injects messages into Claude Code session
  const sessionProvider = new SessionInjectionProvider(
    "session-injection",
    (message: string) => orchestrator.injectMessage(message)
  );
  tinyBus.registerProvider(sessionProvider);

  // 2. Chat message provider - handles UI chat messages
  const chatProvider = new ChatMessageProvider(
    "chat-handler",
    (message: string) => orchestrator.handleUserMessage(message)
  );
  tinyBus.registerProvider(chatProvider);

  // 3. Conversation provider - writes messages to CONVERSATION.md when effectively paused
  const conversationProvider = new ConversationProvider(
    "conversation",
    conversationManager,
    clock,
    () => orchestrator.getState(), // getState callback
    () => orchestrator.getRateLimitUntil() !== null // isRateLimited callback
  );
  tinyBus.registerProvider(conversationProvider);

  // Create PeerAvailabilityMonitor if peer config is provided
  const monitoredPeers: Array<{ peerId: string; apiStatusUrl: string }> = [];

  // Prefer Agora peer config URLs and derive /api/loop/status from each peer's webhook URL.
  const agoraPeers = (agoraConfig as { peers?: unknown } | null)?.peers;
  if (agoraPeers && typeof agoraPeers === "object") {
    const entries = agoraPeers instanceof Map
      ? Array.from(agoraPeers.entries())
      : Object.entries(agoraPeers as Record<string, unknown>);
    for (const [peerId, value] of entries) {
      const url = (value as { url?: unknown } | undefined)?.url;
      if (typeof url !== "string") {
        continue;
      }
      const statusUrl = deriveApiStatusUrl(url);
      if (!statusUrl) {
        logger.debug(`[PEER-MONITOR] Skipping peer ${peerId}: invalid URL in Agora config (${url})`);
        continue;
      }
      monitoredPeers.push({ peerId, apiStatusUrl: statusUrl });
    }
  }

  // Backward compatibility: allow app-level peers when Agora config is unavailable.
  if (monitoredPeers.length === 0 && config.peers && config.peers.length > 0) {
    for (const peer of config.peers) {
      monitoredPeers.push({
        peerId: peer.name,
        apiStatusUrl: `http://localhost:${peer.port}/api/loop/status`,
      });
    }
  }

  const peerMonitorStatePath = monitoredPeers.length > 0
    ? path.resolve(config.substratePath, "..", ".peer-monitor-state.json")
    : undefined;
  const peerMonitor = monitoredPeers.length > 0
    ? new PeerAvailabilityMonitor(monitoredPeers, orchestrator, logger, undefined, fs, peerMonitorStatePath)
    : null;
  if (peerMonitor) {
    await peerMonitor.loadState(clock.now());
    orchestrator.setBeforeCycleHook(() => peerMonitor.scanAll(clock.now()));
  }

  // 4. Agora outbound provider - handles outbound agora.send messages (if configured)
  if (agoraService) {
    agoraOutboundProvider = new AgoraOutboundProvider(
      agoraService,
      logger,
      agoraMessageHandler?.getSeenKeyStore(),
      peerMonitor?.onContactFailed.bind(peerMonitor),
      conversationManager,
      clock,
    );
    tinyBus.registerProvider(agoraOutboundProvider);
  }

  // Start TinyBus
  await tinyBus.start();

  // TinyBus observability (#223) — logging is now handled internally by TinyBus (ILogger injected above).
  // Wire PerformanceMetrics recording via message.complete event (deferred until performanceMetrics exists below).

  httpServer.setOrchestrator(orchestrator);
  httpServer.setDependencies({ reader, ego });
  httpServer.setEventSink(wsServer, clock);
  httpServer.setLogger(logger);
  httpServer.setMeta(await metaManager.read());
  if (config.apiToken) {
    httpServer.setApiToken(config.apiToken);
  }
  httpServer.setCanaryRoute(id, canaryLogger, idLauncherName);

  // Set up TinyBus MCP server
  httpServer.setTinyBus(tinyBus);

  // Set up Code Dispatch layer
  const codeDispatchRunner = new NodeProcessRunner();
  const codeBackends = new Map<BackendType, ICodeBackend>([
    ["claude", new ClaudeCliBackend(codeDispatchRunner, clock, config.tacticalModel)],
    ["copilot", new CopilotBackend(codeDispatchRunner, clock)],
    ["gemini", new GeminiCliBackend(codeDispatchRunner, clock, config.tacticalModel)],
  ]);
  const defaultBackend = (config.defaultCodeBackend ?? "auto") as BackendType;
  const codeDispatcher = new CodeDispatcher(fs, codeDispatchRunner, config.substratePath, codeBackends, clock, defaultBackend);
  httpServer.setCodeDispatcher(codeDispatcher);

  if (agoraService && agoraMessageHandler) {
    httpServer.setAgoraMessageHandler(agoraMessageHandler, agoraService);
  }

  // Create metrics store for quantitative drift monitoring
  const metricsStore = new MetricsStore(fs, clock, config.substratePath);
  httpServer.setHealthCheck(new HealthCheck(reader, metricsStore, fs, config.substratePath));
  httpServer.setMetricsComponents(taskMetrics, sizeTracker, delegationTracker);

  // Create governance report store and wire into both httpServer and orchestrator
  const reportsDir = path.resolve(config.substratePath, "..", "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const reportStore = new GovernanceReportStore(fs, reportsDir, clock);
  httpServer.setReportStore(reportStore);
  orchestrator.setReportStore(reportStore);
  orchestrator.setDriveQualityTracker(driveQualityTracker);

  // Create performance metrics collector and wire into orchestrator (guarded by metrics.enabled)
  if (config.metrics?.enabled !== false) {
    const performanceMetrics = new PerformanceMetrics(fs, clock, config.substratePath);
    orchestrator.setPerformanceMetrics(performanceMetrics);

    // TinyBus → PerformanceMetrics wiring (#223): record message routing latency
    tinyBus.on("message.complete", (data) => {
      const d = data as {
        message: Message;
        durationMs: number;
        routedTo: number;
        successCount: number;
        errorCount: number;
      };
      performanceMetrics.recordTinyBusMessage(
        d.durationMs,
        d.message.type,
        d.message.source ?? "unknown",
        d.routedTo,
        d.errorCount === 0,
        d.message.destination,
      ).catch(() => { /* best-effort — never interrupt the bus */ });
    });
  }

  // Wire Agora service into orchestrator for sending agoraReplies
  // from Subconscious/Ego structured JSON output
  if (agoraService) {
    orchestrator.setAgoraService(
      agoraService,
      () => buildPeerReferenceDirectory(agoraService, agoraMessageHandler?.getSeenKeyStore() ?? undefined)
    );
  }

  // INS (Involuntary Nervous System) — pre-cycle deterministic rule checks
  {
    const { INSHook, ComplianceStateManager, defaultINSConfig, insMaintenanceTrim } = await import("./ins");
    const insConfig = defaultINSConfig(config.substratePath);
    const complianceState = await ComplianceStateManager.load(insConfig.statePath, fs, logger);
    const insHook = new INSHook(reader, fs, clock, logger, insConfig, complianceState);
    orchestrator.setINSHook(insHook);
    // Wire deterministic rate-limit trim — no LLM call, runs before each rate-limit re-sleep.
    const conversationPath = path.join(config.substratePath, "CONVERSATION.md");
    const progressPath = path.join(config.substratePath, "PROGRESS.md");
    orchestrator.setRateLimitTrimFn(() =>
      insMaintenanceTrim(conversationPath, insConfig.conversationLineThreshold, fs, logger, progressPath),
    );
    // ComplianceStateManager saves after each state change in INSHook — no shutdown hook needed.
  }

  // Endorsement interceptor — compliance circuit-breaker
  {
    const boundariesPath = path.join(config.substratePath, "BOUNDARIES.md");
    const endorsementLogPath = path.join(config.substratePath, "..", "endorsement.log");
    const screener = new EndorsementScreener(
      fs,
      gatedLauncher,
      clock,
      {
        boundariesPath,
        logPath: endorsementLogPath,
        screenerModel: "haiku",
      }
    );
    const interceptor = new EndorsementInterceptor(screener);
    orchestrator.setEndorsementInterceptor(interceptor);
  }

  const rateLimitStatePath = path.resolve(config.substratePath, "..", ".rate-limit-state");
  const dedupStatePath = path.resolve(config.substratePath, "..", ".agora-dedup-state");

  orchestrator.setLauncher(launcher);
  // Set shutdown function that closes resources before exiting
  orchestrator.setShutdown((code) => {
    const graceMs = config.shutdownGraceMs ?? 5000;
    // Close resources before exit to ensure clean shutdown
    // Start async cleanup, then exit after it completes or times out
    const cleanupPromise = (async () => {
      // Signal active session with a shutdown notice before force-kill
      if (launcher.isActive()) {
        try {
          launcher.inject("[SHUTDOWN] Server is shutting down. Please wrap up your current work.");
        } catch { /* ignore injection errors during shutdown */ }
        // Brief pause so the notice reaches the active session
        await new Promise(resolve => setTimeout(resolve, 500));
      }

      // Persist rate-limit timestamp so a restarted server honours the remaining backoff
      try {
        await fs.writeFile(rateLimitStatePath, orchestrator.getRateLimitUntil() ?? "");
      } catch { /* ignore */ }

      // Persist Agora dedup envelope IDs to prevent replay across restarts
      if (agoraMessageHandler) {
        try {
          await fs.writeFile(dedupStatePath, JSON.stringify(agoraMessageHandler.getProcessedEnvelopeIds()));
        } catch { /* ignore */ }
      }

      try {
        orchestrator.stop(); // Stop orchestrator (stops watchdog, etc.)
      } catch {
        // Ignore errors if already stopped
      }
      try {
        fileWatcher.stop();
      } catch {
        // Ignore errors
      }
      try {
        await wsServer.close();
      } catch {
        // Ignore errors
      }
      try {
        await httpServer.close();
      } catch {
        // Ignore errors
      }
    })();

    // Wait for cleanup with a configurable grace timeout, then exit
    Promise.race([
      cleanupPromise,
      new Promise(resolve => setTimeout(resolve, graceMs))
    ]).finally(() => {
      process.exit(code);
    });
  });

  // Rate limit state manager setup
  const rateLimitStateManager = new RateLimitStateManager(
    fs, substrateConfig, lock, clock, appendWriter, writer, reader
  );
  orchestrator.setRateLimitStateManager(rateLimitStateManager);

  if (config.mode === "tick") {
    httpServer.setMode("tick");
  }

  // Collect scheduler adapters; wire as a single SchedulerCoordinator after all are built
  const schedulers: IScheduler[] = [];

  // Backup scheduler setup
  if (config.enableBackups !== false) { // Default enabled
    const backupDir = path.resolve(config.substratePath, "..", "backups");
    const appPaths = getAppPaths();
    const stateFilePath = path.join(appPaths.config, "last-backup.txt");
    const runner = new NodeProcessRunner();
    const backupScheduler = new BackupScheduler(
      fs,
      runner,
      clock,
      logger,
      {
        substratePath: config.substratePath,
        backupDir,
        backupIntervalMs: config.backupIntervalMs ?? 86400000, // Default: 24 hours
        retentionCount: config.backupRetentionCount ?? 14, // Default: keep 14 backups
        verifyBackups: true,
        stateFilePath,
      }
    );
    schedulers.push({
      shouldRun: () => backupScheduler.shouldRunBackup(),
      run: async () => {
        const cycleNumber = orchestrator.getCycleNumber();
        logger.debug(`backup: starting scheduled backup (cycle ${cycleNumber})`);
        try {
          const result = await backupScheduler.runBackup();
          if (result.success) {
            logger.debug(`backup: success — ${result.backupPath} (verified: ${result.verification?.valid ?? false})`);
            wsServer.emit({ type: "backup_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: true, backupPath: result.backupPath, verified: result.verification?.valid ?? false, checksum: result.verification?.checksum, sizeBytes: result.verification?.sizeBytes } });
          } else {
            logger.debug(`backup: failed — ${result.error}`);
            wsServer.emit({ type: "backup_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: result.error } });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.debug(`backup: unexpected error — ${errorMsg}`);
          wsServer.emit({ type: "backup_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: errorMsg } });
        }
      },
    });
    httpServer.setBackupScheduler(backupScheduler);
  }

  // Wire conversation manager into HTTP server (always set, even if archiving disabled)
  httpServer.setConversationManager(conversationManager);

  // Email scheduler setup
  if (config.email?.enabled) {
    const appPaths = getAppPaths();
    const progressFilePath = path.join(config.substratePath, "PROGRESS.md");
    const stateFilePath = path.join(appPaths.config, "email-scheduler-state.json");
    const emailScheduler = new EmailScheduler(
      fs,
      clock,
      logger,
      {
        substratePath: config.substratePath,
        progressFilePath,
        emailTime: {
          hour: config.email.sendTimeHour ?? 5,
          minute: config.email.sendTimeMinute ?? 0,
        },
        emailIntervalMs: (config.email.intervalHours ?? 24) * 3600000,
        stateFilePath,
      }
    );
    schedulers.push({
      shouldRun: () => emailScheduler.shouldRunEmail(),
      run: async () => {
        const cycleNumber = orchestrator.getCycleNumber();
        logger.debug(`email: starting scheduled email (cycle ${cycleNumber})`);
        try {
          const result = await emailScheduler.runEmail();
          if (result.success && result.content) {
            logger.debug(`email: success — ${result.content.subject}`);
            wsServer.emit({ type: "email_sent", timestamp: clock.now().toISOString(), data: { cycleNumber, success: true, subject: result.content.subject, bodyPreview: result.content.body.substring(0, 100) } });
          } else {
            logger.debug(`email: failed — ${result.error}`);
            wsServer.emit({ type: "email_sent", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: result.error } });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.debug(`email: unexpected error — ${errorMsg}`);
          wsServer.emit({ type: "email_sent", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: errorMsg } });
        }
      },
    });
  }

  // Health check scheduler setup
  if (config.enableHealthChecks !== false) { // Default enabled
    const healthCheck = new HealthCheck(reader, metricsStore);
    const healthCheckScheduler = new HealthCheckScheduler(
      healthCheck,
      clock,
      logger,
      {
        checkIntervalMs: config.healthCheckIntervalMs ?? 3600000, // Default: 1 hour
      }
    );
    schedulers.push({
      urgent: false,
      invokesLlm: true,
      shouldRun: async () => healthCheckScheduler.shouldRunCheck(),
      run: async () => {
        const cycleNumber = orchestrator.getCycleNumber();
        logger.debug(`health_check: starting scheduled check (cycle ${cycleNumber})`);
        try {
          const result = await healthCheckScheduler.runCheck();
          if (result.success && result.result) {
            logger.debug(`health_check: complete — overall: ${result.result.overall}`);
            wsServer.emit({ type: "health_check_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: true, overall: result.result.overall, drift: { score: result.result.drift.score, findings: result.result.drift.findings.length }, consistency: { consistent: result.result.consistency.inconsistencies.length === 0, issues: result.result.consistency.inconsistencies.length }, security: { compliant: result.result.security.compliant, issues: result.result.security.issues.length }, planQuality: { score: result.result.planQuality.score, findings: result.result.planQuality.findings.length }, reasoning: { valid: result.result.reasoning.valid, issues: result.result.reasoning.issues.length } } });
          } else {
            logger.debug(`health_check: failed — ${result.error}`);
            wsServer.emit({ type: "health_check_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: result.error } });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.debug(`health_check: unexpected error — ${errorMsg}`);
          wsServer.emit({ type: "health_check_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: errorMsg } });
        }
      },
    });
  }

  // Metrics scheduler setup
  if (config.metrics?.enabled !== false) { // Default enabled
    const appPaths = getAppPaths();
    const stateFilePath = path.join(appPaths.config, "metrics-scheduler-state.txt");
    const metricsScheduler = new MetricsScheduler(
      fs,
      clock,
      logger,
      {
        substratePath: config.substratePath,
        metricsIntervalMs: config.metrics?.intervalMs ?? 604800000, // Default: 7 days
        stateFilePath,
      },
      taskMetrics,
      sizeTracker,
      delegationTracker
    );
    schedulers.push({
      urgent: false,
      invokesLlm: true,
      shouldRun: () => metricsScheduler.shouldRunMetrics(),
      run: async () => {
        const cycleNumber = orchestrator.getCycleNumber();
        logger.debug(`metrics: starting scheduled metrics collection (cycle ${cycleNumber})`);
        try {
          const result = await metricsScheduler.runMetrics();
          if (result.success) {
            logger.debug(`metrics: success — collected: ${JSON.stringify(result.collected)}`);
            wsServer.emit({ type: "metrics_collected", timestamp: clock.now().toISOString(), data: { cycleNumber, success: true, collected: result.collected } });
          } else {
            logger.debug(`metrics: failed — ${result.error}`);
            wsServer.emit({ type: "metrics_collected", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: result.error } });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.debug(`metrics: unexpected error — ${errorMsg}`);
          wsServer.emit({ type: "metrics_collected", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: errorMsg } });
        }
      },
    });

    // Wire up monthly self-improvement metrics collection
    const serverSrcPath = config.sourceCodePath
      ? path.join(config.sourceCodePath, "server", "src")
      : path.join(config.substratePath, "..", "..", "server", "src");
    const selfImprovementCollector = new SelfImprovementMetricsCollector(
      fs,
      config.substratePath,
      serverSrcPath,
      clock,
      reportStore
    );
    metricsScheduler.setSelfImprovementCollector(
      selfImprovementCollector,
      30 * 24 * 60 * 60 * 1000, // 30 days
      () => {
        const m = orchestrator.getMetrics();
        return {
          idleRate: m.totalCycles > 0 ? m.idleCycles / m.totalCycles : 0,
        };
      }
    );
  }

  // Validation scheduler setup
  if (config.validation?.enabled !== false) { // Default enabled
    const appPaths = getAppPaths();
    const stateFilePath = path.join(appPaths.config, "validation-scheduler-state.txt");
    const validationScheduler = new ValidationScheduler(
      fs,
      clock,
      logger,
      {
        substratePath: config.substratePath,
        validationIntervalMs: config.validation?.intervalMs ?? 604800000, // Default: 7 days
        stateFilePath,
      }
    );
    schedulers.push({
      urgent: false,
      shouldRun: () => validationScheduler.shouldRunValidation(),
      run: async () => {
        const cycleNumber = orchestrator.getCycleNumber();
        logger.debug(`validation: starting scheduled substrate validation (cycle ${cycleNumber})`);
        try {
          const result = await validationScheduler.runValidation();
          if (result.success && result.report) {
            const { brokenReferences, orphanedFiles, staleFiles } = result.report;
            logger.debug(`validation: success — ${brokenReferences.length} broken refs, ${orphanedFiles.length} orphaned files, ${staleFiles.length} stale files`);
            wsServer.emit({ type: "validation_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: true, brokenReferences: brokenReferences.length, orphanedFiles: orphanedFiles.length, staleFiles: staleFiles.length } });
          } else {
            logger.debug(`validation: failed — ${result.error}`);
            wsServer.emit({ type: "validation_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: result.error } });
          }
        } catch (err) {
          const errorMsg = err instanceof Error ? err.message : String(err);
          logger.debug(`validation: unexpected error — ${errorMsg}`);
          wsServer.emit({ type: "validation_complete", timestamp: clock.now().toISOString(), data: { cycleNumber, success: false, error: errorMsg } });
        }
      },
    });
  }

  // HeartbeatScheduler — reads HEARTBEAT.md, fires due entries, appends to CONVERSATION.md
  {
    const heartbeatPath = path.join(config.substratePath, "HEARTBEAT.md");
    const conditionEvaluators = new Map<string, IConditionEvaluator>();

    // Agora peer message condition: fires when an inbound Agora message is received
    const agoraPeerMessageCondition = new AgoraPeerMessageCondition();
    conditionEvaluators.set(AgoraPeerMessageCondition.PREFIX, agoraPeerMessageCondition);

    // Loop started condition: fires once on each process startup (for startup pattern scans)
    const loopStartedCondition = new LoopStartedCondition();
    conditionEvaluators.set(LoopStartedCondition.PREFIX, loopStartedCondition);

    // Peer availability condition: fires when a peer transitions from unavailable to available
    if (monitoredPeers.length > 0) {
      const peerAvailabilityCondition = new PeerAvailabilityCondition(monitoredPeers, logger);
      conditionEvaluators.set(PeerAvailabilityCondition.PREFIX, peerAvailabilityCondition);
    }

    const heartbeatScheduler = new HeartbeatScheduler(
      fs,
      clock,
      logger,
      heartbeatPath,
      conversationManager,
      conditionEvaluators,
      orchestrator
    );
    schedulers.push(heartbeatScheduler);
    orchestrator.setSchedulerCoordinator(new SchedulerCoordinator(schedulers, config.schedulerCoalesceEnabled ?? true));

    // Wire the agora message notification into AgoraMessageHandler
    if (agoraMessageHandler) {
      agoraMessageHandler.setOnMessageProcessed(() => agoraPeerMessageCondition.notifyMessage());
    }
  }

  // Watchdog — detects stalls and injects gentle reminders
  const watchdogConfig = config.watchdog ?? {};
  if (!watchdogConfig.disabled) {
    const forceRestartThresholdMs = watchdogConfig.forceRestartThresholdMs ?? 10 * 60 * 1000; // 10 minutes after reminder
    const watchdog = new LoopWatchdog({
      clock,
      logger,
      injectMessage: (msg) => orchestrator.injectMessage(msg),
      stallThresholdMs: watchdogConfig.stallThresholdMs ?? 20 * 60 * 1000, // 20 minutes
      forceRestart: forceRestartThresholdMs > 0 ? () => {
        logger.debug("watchdog: force-restarting — session likely died silently");
        orchestrator.requestRestart();
      } : undefined,
      forceRestartThresholdMs,
    });
    orchestrator.setWatchdog(watchdog);
    watchdog.start(watchdogConfig.checkIntervalMs ?? 5 * 60 * 1000); // Check every 5 minutes
  }

  // Tick mode wiring
  if (config.mode === "tick") {
    const tickPromptBuilder = new TickPromptBuilder(reader, {
      substratePath: config.substratePath,
      sourceCodePath: config.sourceCodePath,
    });
    const sdkSessionFactory = createSdkSessionFactory(sdkQuery);
    orchestrator.setTickDependencies({ tickPromptBuilder, sdkSessionFactory });
  }

  // Startup scan: check CONVERSATION.md for **[UNPROCESSED]** messages from before a restart.
  // If found, queue a startup prompt so the agent will check for and handle them on the first cycle.
  // The regex matches the badge only in the format AgoraMessageHandler and ConversationProvider
  // actually write it: after a colon (e.g. "publish: **[UNPROCESSED]**" or "(type):**[UNPROCESSED]**").
  // This avoids false triggers from backtick-quoted mentions in EGO log entries like
  // `**[UNPROCESSED]**` that discuss the marker rather than being actual markers.
  try {
    const conversationContent = await reader.read(SubstrateFileType.CONVERSATION);
    // #238: Filter startup scan to exclude announce messages — they are informational
    // broadcasts (e.g. heartbeat/capability ads) that don't require agent response.
    // Only trigger STARTUP SCAN for actionable [UNPROCESSED] messages.
    const lines = conversationContent.rawMarkdown.split("\n");
    const hasActionableUnprocessed = lines.some(
      (line) => /:\s*\*\*\[UNPROCESSED\]\*\*/.test(line) && !/ announce:\s*\*\*\[UNPROCESSED\]\*\*/.test(line)
    );
    if (hasActionableUnprocessed) {
      const startupPrompt = "[STARTUP SCAN] Unprocessed messages detected in CONVERSATION.md from before the last restart. Please read CONVERSATION.md and respond to any messages marked with **[UNPROCESSED]**.";
      orchestrator.queueStartupMessage(startupPrompt);
      logger.debug("createApplication: queued startup message for unprocessed messages in CONVERSATION.md");
    }
  } catch {
    // CONVERSATION.md may not exist yet (first run) — skip startup scan
    logger.debug("createApplication: startup scan skipped (CONVERSATION.md not readable)");
  }

  // Restore rate-limit state from before the last shutdown (prevents hammering the API on restart).
  // Cap at 2 hours from now to avoid multi-day sleeps from poisoning the restart loop.
  try {
    const stored = (await fs.readFile(rateLimitStatePath)).trim();
    if (stored) {
      const rateLimitDate = new Date(stored);
      if (rateLimitDate > clock.now()) {
        const maxBackoffMs = 2 * 60 * 60 * 1000;
        const remainingMs = rateLimitDate.getTime() - clock.now().getTime();
        if (remainingMs > maxBackoffMs) {
          const capped = new Date(clock.now().getTime() + maxBackoffMs).toISOString();
          logger.debug(`createLoopLayer: restored rateLimitUntil ${stored} exceeds 2h cap — clamped to ${capped}`);
          orchestrator.setRateLimitUntil(capped);
        } else {
          orchestrator.setRateLimitUntil(stored);
          logger.debug(`createLoopLayer: restored rateLimitUntil from disk: ${stored}`);
        }
      }
    }
  } catch { /* file absent — no rate-limit state to restore */ }

  // Restore Agora dedup envelope IDs from before the last shutdown (prevents replay across restarts).
  if (agoraMessageHandler) {
    try {
      const stored = await fs.readFile(dedupStatePath);
      const ids = JSON.parse(stored) as string[];
      agoraMessageHandler.setProcessedEnvelopeIds(ids);
      logger.debug(`createLoopLayer: restored ${ids.length} Agora dedup envelope IDs from disk`);
    } catch { /* file absent — no dedup state to restore */ }
  }

  // Connect to the Agora relay only AFTER all startup state has been fully restored.
  //
  // Rationale: messages from the relay can arrive immediately on connectRelay(). By
  // connecting here (the very end of createLoopLayer, after all setup):
  //
  // 1. Dedup state is loaded — the full processedEnvelopeIds set is in place, so relay
  //    replays of previously-seen envelopes are correctly blocked by isDuplicate().
  //
  // 2. Rate-limit state is restored — isRateLimited() returns the correct value, so
  //    the [UNPROCESSED] badge and pendingMessages handling are correct.
  //
  // 3. All orchestrator dependencies (launcher, INS hook, watchdog, etc.) are wired —
  //    if the loop was persisted in SLEEPING state, wakeLoop() fires and starts runLoop()
  //    with a fully-initialized orchestrator.
  //
  // Messages buffered by the relay while the substrate was unresponsive are replayed
  // immediately after connection, so no messages are lost by deferring.
  if (agoraService && agoraConfig?.relay?.autoConnect && agoraConfig.relay.url) {
    await agoraService.connectRelay(agoraConfig.relay.url);
    logger.debug(`Connected to Agora relay at ${agoraConfig.relay.url}`);
  }

  return { orchestrator, httpServer, wsServer, fileWatcher, tinyBus, mode };
}

function deriveApiStatusUrl(peerWebhookUrl: string): string | null {
  try {
    const parsed = new URL(peerWebhookUrl);
    parsed.pathname = "/api/loop/status";
    parsed.search = "";
    parsed.hash = "";
    return parsed.toString();
  } catch {
    return null;
  }
}
