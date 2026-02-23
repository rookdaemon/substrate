import * as path from "path";
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
import { TickPromptBuilder } from "../session/TickPromptBuilder";
import { createSdkSessionFactory } from "../session/SdkSessionAdapter";
import { BackupScheduler } from "./BackupScheduler";
import { NodeProcessRunner } from "../agents/claude/NodeProcessRunner";
import { HealthCheckScheduler } from "./HealthCheckScheduler";
import { EmailScheduler } from "./EmailScheduler";
import { MetricsScheduler } from "./MetricsScheduler";
import { ValidationScheduler } from "./ValidationScheduler";
import { SelfImprovementMetricsCollector } from "../evaluation/SelfImprovementMetrics";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import type { AgoraService } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import { LoopWatchdog } from "./LoopWatchdog";
import { getAppPaths } from "../paths";
import { TinyBus, SessionInjectionProvider, ChatMessageProvider } from "../tinybus";
import { ConversationProvider } from "../tinybus/providers/ConversationProvider";
import { AgoraMessageHandler } from "../agora/AgoraMessageHandler";
import { AgoraOutboundProvider } from "../agora/AgoraOutboundProvider";
import { AgoraInboxManager } from "../agora/AgoraInboxManager";
import { IAgoraService } from "../agora/IAgoraService";
import { FileWatcher } from "../substrate/watcher/FileWatcher";
import { SubstrateFileType } from "../substrate/types";
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
  const { ego, subconscious, superego, id, conversationManager, launcher,
    taskMetrics, sizeTracker, delegationTracker, driveQualityTracker } = agents;

  // Loop layer — build httpServer first for the underlying http.Server,
  // then wsServer, then orchestrator, then wire orchestrator back into httpServer
  const loopConfig = defaultLoopConfig({
    cycleDelayMs: config.cycleDelayMs,
    superegoAuditInterval: config.superegoAuditInterval,
    maxConsecutiveIdleCycles: config.idleSleepConfig?.enabled
      ? config.idleSleepConfig.idleCyclesBeforeSleep
      : config.maxConsecutiveIdleCycles,
    idleSleepEnabled: config.idleSleepConfig?.enabled ?? false,
  });

  const httpServer = new LoopHttpServer();
  const wsServer = new LoopWebSocketServer(httpServer.getServer());
  const timer = new NodeTimer();

  // File watcher for substrate files - emits file_changed events via websocket
  const fileWatcher = new FileWatcher(substrateConfig, wsServer, clock);

  // Create TinyBus instance for message routing
  const tinyBus = new TinyBus();

  // Agora service for agent-to-agent communication
  let agoraService: IAgoraService | null = null;
  let agoraMessageHandler: AgoraMessageHandler | null = null;
  let agoraOutboundProvider: AgoraOutboundProvider | null = null;
  let agoraConfig: Awaited<ReturnType<typeof AgoraService.loadConfig>> | null = null;
  try {
    const agora = await import("@rookdaemon/agora");
    agoraConfig = await agora.AgoraService.loadConfig();
    agoraService = new agora.AgoraService(agoraConfig, logger) as unknown as IAgoraService;

    // Note: We'll create AgoraMessageHandler after orchestrator is created
    // so we can pass it as IMessageInjector

    // Connect to relay if configured (will set handler after orchestrator creation)
    if (agoraService && agoraConfig.relay?.autoConnect && agoraConfig.relay.url) {
      await agoraService.connectRelay(agoraConfig.relay.url);
      logger.debug(`Connected to Agora relay at ${agoraConfig.relay.url}`);
    }
  } catch (err) {
    // If Agora config doesn't exist, log and continue without Agora capability
    logger.debug("Agora not configured: " + (err instanceof Error ? err.message : String(err)));
  }

  const idleHandler = new IdleHandler(id, superego, ego, clock, logger);

  const orchestrator = new LoopOrchestrator(
    ego, subconscious, superego, id,
    appendWriter, clock, timer, wsServer, loopConfig,
    logger, idleHandler,
    config.conversationIdleTimeoutMs,
    substrate.findingTracker,
    substrate.findingTrackerSave,
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
    // Create AgoraInboxManager for quarantine support
    const agoraInboxManager = new AgoraInboxManager(fs, substrateConfig, lock, clock);

    const rateLimitConfig = config.agora?.security?.perSenderRateLimit ?? {
      enabled: true,
      maxMessages: 10,
      windowMs: 60000,
    };

    agoraMessageHandler = new AgoraMessageHandler(
      agoraService,
      conversationManager,
      orchestrator, // implements IMessageInjector
      wsServer,
      clock,
      () => orchestrator.getState(), // getState callback
      () => orchestrator.getRateLimitUntil() !== null, // isRateLimited callback
      logger,
      config.agora?.security?.unknownSenderPolicy ?? 'quarantine', // Default to quarantine
      agoraInboxManager, // for quarantine support
      rateLimitConfig, // Rate limit config
      () => { // wakeLoop callback — wake orchestrator if sleeping on incoming Agora message
        try { orchestrator.wake(); } catch { /* not sleeping */ }
      }
    );

    // Set up relay message handler if relay is configured
    if (agoraConfig.relay?.autoConnect && agoraConfig.relay.url) {
      const agora = await import("@rookdaemon/agora");
      agoraService.setRelayMessageHandlerWithName(async (envelope: Envelope, from: string, fromName?: string) => {
        try {
          logger.debug(`[AGORA] Relay message received: envelopeId=${envelope.id} type=${envelope.type} from=${fromName || from}`);

          // SECURITY: Verify signature before processing
          // The relay passes raw envelopes - we must verify them
          const verifyResult = agora.verifyEnvelope(envelope);

          if (!verifyResult.valid) {
            logger.debug(`[AGORA] Rejected relay message: ${verifyResult.reason ?? "invalid signature"} envelopeId=${envelope.id}`);
            return;
          }

          logger.debug(`[AGORA] Relay message verified: envelopeId=${envelope.id}`);

          // Process the verified envelope via AgoraMessageHandler with relay name hint
          await agoraMessageHandler!.processEnvelope(envelope, "relay", fromName);

          logger.debug(`[AGORA] Relay message processed: envelopeId=${envelope.id}`);
        } catch (err) {
          logger.debug(`[AGORA] Failed to process relay message: ${err instanceof Error ? err.message : String(err)}`);
        }
      });
    }
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

  // 4. Agora outbound provider - handles outbound agora.send messages (if configured)
  if (agoraService) {
    agoraOutboundProvider = new AgoraOutboundProvider(agoraService);
    tinyBus.registerProvider(agoraOutboundProvider);
  }

  // Start TinyBus
  await tinyBus.start();

  httpServer.setOrchestrator(orchestrator);
  httpServer.setDependencies({ reader, ego });
  httpServer.setEventSink(wsServer, clock);
  httpServer.setLogger(logger);
  httpServer.setMeta(await metaManager.read());

  // Set up TinyBus MCP server
  httpServer.setTinyBus(tinyBus);

  if (agoraService && agoraMessageHandler) {
    httpServer.setAgoraMessageHandler(agoraMessageHandler, agoraService);
  }

  // Create metrics store for quantitative drift monitoring
  const metricsStore = new MetricsStore(fs, clock, config.substratePath);
  httpServer.setHealthCheck(new HealthCheck(reader, metricsStore));
  httpServer.setMetricsComponents(taskMetrics, sizeTracker, delegationTracker);

  // Create governance report store and wire into both httpServer and orchestrator
  const reportsDir = path.resolve(config.substratePath, "..", "reports");
  await fs.mkdir(reportsDir, { recursive: true });
  const reportStore = new GovernanceReportStore(fs, reportsDir, clock);
  httpServer.setReportStore(reportStore);
  orchestrator.setReportStore(reportStore);
  orchestrator.setDriveQualityTracker(driveQualityTracker);

  orchestrator.setLauncher(launcher);
  // Set shutdown function that closes resources before exiting
  orchestrator.setShutdown((code) => {
    // Close resources before exit to ensure clean shutdown
    // Start async cleanup, then exit after it completes or times out
    const cleanupPromise = (async () => {
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

    // Wait for cleanup with a timeout, then exit
    Promise.race([
      cleanupPromise,
      new Promise(resolve => setTimeout(resolve, 1000)) // 1 second timeout
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
    orchestrator.setBackupScheduler(backupScheduler);
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
    orchestrator.setEmailScheduler(emailScheduler);
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
    orchestrator.setHealthCheckScheduler(healthCheckScheduler);
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
    orchestrator.setMetricsScheduler(metricsScheduler);

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
    orchestrator.setValidationScheduler(validationScheduler);
  }

  // Watchdog — detects stalls and injects gentle reminders
  const watchdog = new LoopWatchdog({
    clock,
    logger,
    injectMessage: (msg) => orchestrator.injectMessage(msg),
    stallThresholdMs: 20 * 60 * 1000, // 20 minutes
  });
  orchestrator.setWatchdog(watchdog);
  watchdog.start(5 * 60 * 1000); // Check every 5 minutes

  // Tick mode wiring
  if (config.mode === "tick") {
    const tickPromptBuilder = new TickPromptBuilder(reader, {
      substratePath: config.substratePath,
      sourceCodePath: config.sourceCodePath,
    });
    const sdkSessionFactory = createSdkSessionFactory(sdkQuery);
    orchestrator.setTickDependencies({ tickPromptBuilder, sdkSessionFactory });
  }

  // Startup scan: check CONVERSATION.md for [UNPROCESSED] messages from before a restart.
  // If found, queue a startup prompt so the agent will check for and handle them on the first cycle.
  try {
    const conversationContent = await reader.read(SubstrateFileType.CONVERSATION);
    if (conversationContent.rawMarkdown.includes("[UNPROCESSED]")) {
      const startupPrompt = "[STARTUP SCAN] Unprocessed messages detected in CONVERSATION.md from before the last restart. Please read CONVERSATION.md and respond to any messages marked with [UNPROCESSED].";
      orchestrator.queueStartupMessage(startupPrompt);
      logger.debug("createApplication: queued startup message for unprocessed messages in CONVERSATION.md");
    }
  } catch {
    // CONVERSATION.md may not exist yet (first run) — skip startup scan
    logger.debug("createApplication: startup scan skipped (CONVERSATION.md not readable)");
  }

  return { orchestrator, httpServer, wsServer, fileWatcher, tinyBus, mode };
}
