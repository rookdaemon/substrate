import * as path from "path";
import { NodeFileSystem } from "../substrate/abstractions/NodeFileSystem";
import { SystemClock } from "../substrate/abstractions/SystemClock";
import { SubstrateConfig } from "../substrate/config";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileWriter } from "../substrate/io/FileWriter";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { FileLock } from "../substrate/io/FileLock";
import { SubstrateFileType } from "../substrate/types";
import { PermissionChecker } from "../agents/permissions";
import { PromptBuilder } from "../agents/prompts/PromptBuilder";
import { AgentSdkLauncher, SdkQueryFn } from "../agents/claude/AgentSdkLauncher";
import { TaskClassifier } from "../agents/TaskClassifier";
import { ConversationCompactor } from "../conversation/ConversationCompactor";
import { ConversationArchiver } from "../conversation/ConversationArchiver";
import { ConversationManager, ConversationArchiveConfig } from "../conversation/ConversationManager";
import { Ego } from "../agents/roles/Ego";
import { Subconscious } from "../agents/roles/Subconscious";
import { Superego } from "../agents/roles/Superego";
import { Id } from "../agents/roles/Id";
import { FileLogger } from "../logging";
import { NodeTimer } from "./NodeTimer";
import { LoopOrchestrator } from "./LoopOrchestrator";
import { IdleHandler } from "./IdleHandler";
import { LoopHttpServer } from "./LoopHttpServer";
import { LoopWebSocketServer } from "./LoopWebSocketServer";
import { defaultLoopConfig } from "./types";
import { HealthCheck } from "../evaluation/HealthCheck";
import { MetricsStore } from "../evaluation/MetricsStore";
import { TickPromptBuilder } from "../session/TickPromptBuilder";
import { createSdkSessionFactory } from "../session/SdkSessionAdapter";
import { BackupScheduler } from "./BackupScheduler";
import { NodeProcessRunner } from "../agents/claude/NodeProcessRunner";
import { HealthCheckScheduler } from "./HealthCheckScheduler";
import { EmailScheduler } from "./EmailScheduler";
import { MetricsScheduler } from "./MetricsScheduler";
import { TaskClassificationMetrics } from "../evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../evaluation/DelegationTracker";
import { AgoraService } from "../agora/AgoraService";
import { AgoraInboxManager } from "../agora/AgoraInboxManager";
import { LoopWatchdog } from "./LoopWatchdog";
import { getAppPaths } from "../paths";

export interface ApplicationConfig {
  substratePath: string;
  workingDirectory?: string;
  sourceCodePath?: string;
  model?: string;
  strategicModel?: string;
  tacticalModel?: string;
  httpPort?: number;
  cycleDelayMs?: number;
  superegoAuditInterval?: number;
  maxConsecutiveIdleCycles?: number;
  mode?: "cycle" | "tick";
  sdkQueryFn?: SdkQueryFn;
  enableBackups?: boolean;
  backupIntervalMs?: number;
  backupRetentionCount?: number;
  enableHealthChecks?: boolean;
  healthCheckIntervalMs?: number;
  conversationArchive?: {
    enabled: boolean;
    linesToKeep: number;
    sizeThreshold: number;
    timeThresholdDays?: number;
  };
  email?: {
    enabled: boolean;
    intervalHours: number;
    sendTimeHour: number;
    sendTimeMinute: number;
  };
  metrics?: {
    enabled: boolean;
    intervalMs?: number; // Default: 604800000 (7 days)
  };
}

export interface Application {
  orchestrator: LoopOrchestrator;
  httpServer: LoopHttpServer;
  wsServer: LoopWebSocketServer;
  logPath: string;
  mode: "cycle" | "tick";
  start(port?: number, forceStart?: boolean): Promise<number>;
  stop(): Promise<void>;
}

export async function createApplication(config: ApplicationConfig): Promise<Application> {
  // SDK — dynamic import required (ESM package in CommonJS project)
  // Tests inject sdkQueryFn directly to avoid dynamic import issues in Jest
  const sdkQuery = config.sdkQueryFn
    ?? (await import("@anthropic-ai/claude-agent-sdk")).query as unknown as SdkQueryFn;

  // Substrate layer
  const fs = new NodeFileSystem();
  const clock = new SystemClock();
  const substrateConfig = new SubstrateConfig(config.substratePath);
  const reader = new SubstrateFileReader(fs, substrateConfig);
  const lock = new FileLock();
  const writer = new SubstrateFileWriter(fs, substrateConfig, lock);
  const appendWriter = new AppendOnlyWriter(fs, substrateConfig, lock, clock);

  // Logger — created early so all layers can use it
  const logPath = path.resolve(config.substratePath, "..", "debug.log");
  const logger = new FileLogger(logPath);

  // Agent layer
  const checker = new PermissionChecker();
  const promptBuilder = new PromptBuilder(reader, checker, {
    substratePath: config.substratePath,
    sourceCodePath: config.sourceCodePath,
  });
  const launcher = new AgentSdkLauncher(sdkQuery, clock, config.model, logger);

  // Metrics collection components
  const taskMetrics = new TaskClassificationMetrics(fs, clock, config.substratePath);
  const sizeTracker = new SubstrateSizeTracker(fs, clock, config.substratePath);
  const delegationTracker = new DelegationTracker(fs, clock, config.substratePath);

  // Task classifier for model selection (with optional metrics collection)
  const taskClassifier = new TaskClassifier({
    strategicModel: config.strategicModel ?? "opus",
    tacticalModel: config.tacticalModel ?? "sonnet",
    metricsCollector: config.metrics?.enabled !== false ? taskMetrics : undefined, // Default enabled
  });

  const cwd = config.workingDirectory;
  
  // Conversation manager with compaction and optional archiving
  const compactor = new ConversationCompactor(launcher, cwd);
  
  // Create archiver and archive config if archiving is enabled
  let archiver: ConversationArchiver | undefined;
  let archiveConfig: ConversationArchiveConfig | undefined;
  
  if (config.conversationArchive?.enabled) {
    archiver = new ConversationArchiver(fs, clock, config.substratePath);
    archiveConfig = {
      enabled: config.conversationArchive.enabled,
      linesToKeep: config.conversationArchive.linesToKeep,
      sizeThreshold: config.conversationArchive.sizeThreshold,
      timeThresholdMs: config.conversationArchive.timeThresholdDays
        ? config.conversationArchive.timeThresholdDays * 24 * 60 * 60 * 1000
        : undefined,
    };
  }
  
  const conversationManager = new ConversationManager(
    reader, fs, substrateConfig, lock, appendWriter, checker, compactor, clock,
    archiver, archiveConfig
  );

  const ego = new Ego(reader, writer, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier, cwd);
  const subconscious = new Subconscious(reader, writer, appendWriter, conversationManager, checker, promptBuilder, launcher, clock, taskClassifier, cwd);
  const superego = new Superego(reader, appendWriter, checker, promptBuilder, launcher, clock, taskClassifier, cwd);
  const id = new Id(reader, checker, promptBuilder, launcher, clock, taskClassifier, cwd);

  // Loop layer — build httpServer first for the underlying http.Server,
  // then wsServer, then orchestrator, then wire orchestrator back into httpServer
  const loopConfig = defaultLoopConfig({
    cycleDelayMs: config.cycleDelayMs,
    superegoAuditInterval: config.superegoAuditInterval,
    maxConsecutiveIdleCycles: config.maxConsecutiveIdleCycles,
  });

  const httpServer = new LoopHttpServer(null as unknown as LoopOrchestrator);
  const wsServer = new LoopWebSocketServer(httpServer.getServer());
  const timer = new NodeTimer();

  // Agora service for agent-to-agent communication
  let agoraService: AgoraService | null = null;
  let agoraInboxManager: AgoraInboxManager | null = null;
  try {
    const agoraConfig = await AgoraService.loadConfig();
    agoraService = new AgoraService(agoraConfig, logger);
    agoraInboxManager = new AgoraInboxManager(fs, substrateConfig, lock, clock);

    // Connect to relay if configured
    if (agoraConfig.relay?.autoConnect && agoraConfig.relay.url) {
      const service = agoraService;
      await service.connectRelay(agoraConfig.relay.url);
      logger.debug(`Connected to Agora relay at ${agoraConfig.relay.url}`);

      // Set up relay message handler to process incoming messages
      service.setRelayMessageHandler(async (envelope) => {
        try {
          // SECURITY: Verify signature before processing
          // The relay passes raw envelopes - we must verify them
          const encodedEnvelope = `[AGORA_ENVELOPE]${JSON.stringify(envelope)}`;
          const verifyResult = await service.decodeInbound(encodedEnvelope);

          if (!verifyResult.ok) {
            logger.debug(`Rejected relay message: ${verifyResult.reason}`);
            return;
          }

          // Use verified envelope from decodeInbound
          const verifiedEnvelope = verifyResult.envelope!;

          // Log to PROGRESS.md with truncated payload to avoid excessive log size
          const timestamp = clock.now().toISOString();
          const payloadStr = JSON.stringify(verifiedEnvelope.payload);
          const truncatedPayload = payloadStr.length > 200
            ? payloadStr.substring(0, 200) + "..."
            : payloadStr;
          const logEntry = `[AGORA-RELAY] Received ${verifiedEnvelope.type} from ${verifiedEnvelope.sender.substring(0, 8)}... — payload: ${truncatedPayload}`;
          await appendWriter.append(SubstrateFileType.PROGRESS, logEntry);

          // Emit WebSocket event for frontend visibility
          wsServer.emit({
            type: "agora_message",
            timestamp,
            data: {
              envelopeId: verifiedEnvelope.id,
              messageType: verifiedEnvelope.type,
              sender: verifiedEnvelope.sender,
              payload: verifiedEnvelope.payload,
              source: "relay",
            },
          });
        } catch (err) {
          logger.debug("Failed to process relay message: " + (err instanceof Error ? err.message : String(err)));
        }
      });
    }
  } catch (err) {
    // If Agora config doesn't exist, log and continue without Agora capability
    logger.debug("Agora not configured: " + (err instanceof Error ? err.message : String(err)));
  }

  const idleHandler = new IdleHandler(id, superego, ego, clock, logger);

  const orchestrator = new LoopOrchestrator(
    ego, subconscious, superego, id,
    appendWriter, clock, timer, wsServer, loopConfig,
    logger, idleHandler
  );

  httpServer.setOrchestrator(orchestrator);
  httpServer.setDependencies({ reader, ego });
  httpServer.setEventSink(wsServer, clock);
  if (agoraService && agoraInboxManager) {
    httpServer.setAgoraService(agoraService, appendWriter, agoraInboxManager);
  }

  // Create metrics store for quantitative drift monitoring
  const metricsStore = new MetricsStore(fs, clock, config.substratePath);
  httpServer.setHealthCheck(new HealthCheck(reader, metricsStore));
  httpServer.setMetricsComponents(taskMetrics, sizeTracker, delegationTracker);

  orchestrator.setLauncher(launcher);
  orchestrator.setShutdown((code) => process.exit(code));
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

  // Wire Agora inbox manager into orchestrator if Agora is configured
  if (agoraInboxManager) {
    orchestrator.setAgoraInboxManager(agoraInboxManager);
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

  const mode = config.mode ?? "cycle";

  return {
    orchestrator,
    httpServer,
    wsServer,
    logPath,
    async start(port?: number, forceStart?: boolean): Promise<number> {
      const p = port ?? config.httpPort ?? 3000;
      const boundPort = await httpServer.listen(p);
      if (forceStart) {
        orchestrator.start();
        if (mode === "tick") {
          orchestrator.runTickLoop().catch(() => {});
        } else {
          orchestrator.runLoop().catch(() => {});
        }
      }
      return boundPort;
    },
    async stop(): Promise<void> {
      try { orchestrator.stop(); } catch { /* already stopped */ }
      await wsServer.close();
      await httpServer.close();
    },
    mode,
  };
}
