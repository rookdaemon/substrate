import * as http from "node:http";
import * as crypto from "node:crypto";
import { LoopOrchestrator } from "./LoopOrchestrator";
import { LoopState } from "./types";
import { ILoopEventSink } from "./ILoopEventSink";
import { IClock } from "../substrate/abstractions/IClock";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileType } from "../substrate/types";
import { Ego } from "../agents/roles/Ego";
import { GovernanceReportStore } from "../evaluation/GovernanceReportStore";
import { HealthCheck } from "../evaluation/HealthCheck";
import { BackupScheduler } from "./BackupScheduler";
import { ConversationManager } from "../conversation/ConversationManager";
import { TaskClassificationMetrics } from "../evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../evaluation/DelegationTracker";
import { TinyBus } from "../tinybus/core/TinyBus";
import { createMessage } from "../tinybus/core/Message";
import { createTinyBusMcpServer } from "../mcp/TinyBusMcpServer";
import { addCodeDispatchTools } from "../mcp/CodeDispatchMcpServer";
import { StreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/streamableHttp.js";
import type { CodeDispatcher } from "../code-dispatch/CodeDispatcher";
import { AgoraMessageHandler } from "../agora/AgoraMessageHandler";
import { IAgoraService } from "../agora/IAgoraService";
import type { ILogger } from "../logging";
import { getVersionInfo } from "../version";
import { SubstrateMeta } from "../substrate/MetaManager";
import type { Id } from "../agents/roles/Id";
import { CanaryLogger, ConvMdStats } from "../evaluation/CanaryLogger";

/** Maximum allowed HTTP request body size (1 MiB). Requests exceeding this limit receive HTTP 413. */
const MAX_BODY_BYTES = 1 * 1024 * 1024;

// Lazy singleton for the ESM-only @rookdaemon/agora module.
// Imported once on first use and cached for all subsequent calls.
let _agoraModule: typeof import("@rookdaemon/agora") | null = null;
async function getAgoraModule(): Promise<typeof import("@rookdaemon/agora")> {
  if (!_agoraModule) {
    _agoraModule = await import("@rookdaemon/agora");
  }
  return _agoraModule;
}

export interface LoopHttpDependencies {
  reader: SubstrateFileReader;
  ego: Ego;
}

export class LoopHttpServer {
  private server: http.Server;
  private orchestrator: LoopOrchestrator | null = null;
  private reader: SubstrateFileReader | null = null;
  private ego: Ego | null = null;
  private reportStore: GovernanceReportStore | null = null;
  private healthCheck: HealthCheck | null = null;
  private eventSink: ILoopEventSink | null = null;
  private clock: IClock | null = null;
  private mode: "cycle" | "tick" = "cycle";
  private agoraMessageHandler: AgoraMessageHandler | null = null;
  private agoraService: IAgoraService | null = null;
  private logger: ILogger | null = null;
  private backupScheduler: BackupScheduler | null = null;
  private conversationManager: ConversationManager | null = null;
  private taskMetrics: TaskClassificationMetrics | null = null;
  private sizeTracker: SubstrateSizeTracker | null = null;
  private delegationTracker: DelegationTracker | null = null;
  private tinyBus: TinyBus | null = null;
  private codeDispatcher: CodeDispatcher | null = null;
  private meta: SubstrateMeta | null = null;
  private apiToken: string | null = null;
  private readonly agoraWebhookToken: string | undefined;
  private canaryId: Id | null = null;
  private canaryLogger: CanaryLogger | null = null;
  private canaryLauncherName: string = "claude";
  private canaryLastRunAt: number | null = null;
  private convMdReader: (() => Promise<ConvMdStats | null>) | null = null;
  private static readonly CANARY_RATE_LIMIT_MS = 55 * 60 * 1000; // 55 minutes

  constructor(webhookToken?: string) {
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
    this.agoraWebhookToken = webhookToken;
  }

  setOrchestrator(orchestrator: LoopOrchestrator): void {
    this.orchestrator = orchestrator;
  }

  private get orc(): LoopOrchestrator {
    if (!this.orchestrator) throw new Error("Orchestrator not yet initialized");
    return this.orchestrator;
  }

  setDependencies(deps: LoopHttpDependencies): void {
    this.reader = deps.reader;
    this.ego = deps.ego;
  }

  setReportStore(store: GovernanceReportStore): void {
    this.reportStore = store;
  }

  setHealthCheck(check: HealthCheck): void {
    this.healthCheck = check;
  }

  setEventSink(sink: ILoopEventSink, clock: IClock): void {
    this.eventSink = sink;
    this.clock = clock;
  }

  setMode(mode: "cycle" | "tick"): void {
    this.mode = mode;
  }

  setAgoraMessageHandler(handler: AgoraMessageHandler, service: IAgoraService): void {
    this.agoraMessageHandler = handler;
    this.agoraService = service;
  }

  setLogger(logger: ILogger): void {
    this.logger = logger;
  }

  setBackupScheduler(scheduler: BackupScheduler): void {
    this.backupScheduler = scheduler;
  }

  setConversationManager(manager: ConversationManager): void {
    this.conversationManager = manager;
  }

  setMetricsComponents(
    taskMetrics: TaskClassificationMetrics,
    sizeTracker: SubstrateSizeTracker,
    delegationTracker: DelegationTracker
  ): void {
    this.taskMetrics = taskMetrics;
    this.sizeTracker = sizeTracker;
    this.delegationTracker = delegationTracker;
  }

  setTinyBus(tinyBus: TinyBus): void {
    this.tinyBus = tinyBus;
  }

  setCodeDispatcher(dispatcher: CodeDispatcher): void {
    this.codeDispatcher = dispatcher;
  }

  setMeta(meta: SubstrateMeta | null): void {
    this.meta = meta;
  }

  setApiToken(token: string): void {
    this.apiToken = token;
  }

  setCanaryRoute(id: Id, canaryLogger: CanaryLogger, launcherName: string, convMdReader?: () => Promise<ConvMdStats | null>): void {
    this.canaryId = id;
    this.canaryLogger = canaryLogger;
    this.canaryLauncherName = launcherName;
    this.convMdReader = convMdReader ?? null;
  }

  listen(port: number): Promise<number> {
    if (this.agoraMessageHandler && !this.agoraWebhookToken) {
      this.logger?.warn(
        "[AGORA] AGORA_WEBHOOK_TOKEN not configured — webhook endpoint relies on Ed25519 signature verification only"
      );
    }
    if (!this.apiToken && this.tinyBus) {
      this.logger?.warn(
        "[MCP] API token not configured — /mcp endpoint is unauthenticated. Set apiToken in config to require bearer token auth."
      );
    }
    return new Promise((resolve) => {
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
        // unref() allows the process to exit even if the server is still listening.
        // Process lifecycle in production is managed by systemd/supervisor, not this server.
        this.server.unref();
        resolve(boundPort);
      });
    });
  }

  close(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.server.close((err) => (err ? reject(err) : resolve()));
    });
  }

  getServer(): http.Server {
    return this.server;
  }

  private handleRequest(req: http.IncomingMessage, res: http.ServerResponse): void {
    const url = req.url ?? "";
    const method = req.method ?? "";

    // API token authentication — enforced on all routes including /hooks/agent.
    if (this.apiToken) {
      const authHeader = req.headers.authorization;
      const expected = `Bearer ${this.apiToken}`;
      const valid = authHeader !== undefined &&
        authHeader.length === expected.length &&
        crypto.timingSafeEqual(Buffer.from(authHeader), Buffer.from(expected));
      if (!valid) {
        this.json(res, 401, { error: "Unauthorized" });
        return;
      }
    }

    // Handle MCP requests — SDK 1.26+ stateless mode requires a fresh transport per request
    if ((url === "/mcp" || url === "/") && this.tinyBus) {
      this.handleMcpRequest(req, res);
      return;
    }

    // Match parameterized routes
    const substrateMatch = url.match(/^\/api\/substrate\/([A-Z]+)$/);
    if (method === "GET" && substrateMatch) {
      this.handleSubstrateRead(res, substrateMatch[1]);
      return;
    }

    const route = `${method} ${url}`;

    switch (route) {
      case "GET /api/loop/status": {
        const statusPayload: Record<string, unknown> = {
          state: this.orc.getState(),
          metrics: this.orc.getMetrics(),
          pendingMessages: this.orc.getPendingMessageCount(),
          version: getVersionInfo(),
        };
        const rlu = this.orc.getRateLimitUntil();
        if (rlu) statusPayload.rateLimitUntil = rlu;
        const nhw = this.orc.getNextHeartbeatWake();
        if (nhw) statusPayload.nextHeartbeatWake = nhw;
        if (this.meta) statusPayload.meta = this.meta;
        this.json(res, 200, statusPayload);
        break;
      }

      case "GET /api/loop/metrics":
        this.json(res, 200, this.orc.getMetrics());
        break;

      case "GET /api/metrics":
        this.json(res, 200, {
          fileCache: this.reader ? this.reader.getMetrics() : { cacheHits: 0, cacheMisses: 0 },
        });
        break;
      case "POST /api/loop/start":
        this.tryStateTransition(res, () => {
          const previousState = this.orc.getState();
          this.orc.start();
          // Only start loop if transitioning from STOPPED
          // If rate-limited, the loop is already running, just cleared the rate limit
          if (previousState === LoopState.STOPPED) {
            // Fire-and-forget: start the loop without awaiting
            if (this.mode === "tick") {
              this.orc.runTickLoop().catch(() => {});
            } else {
              this.orc.runLoop().catch(() => {});
            }
          }
        });
        break;

      case "POST /api/loop/pause":
        this.tryStateTransition(res, () => this.orc.pause());
        break;

      case "POST /api/loop/resume":
        this.tryStateTransition(res, () => this.orc.resume());
        break;

      case "POST /api/loop/wake":
        this.tryStateTransition(res, () => this.orc.wake());
        break;

      case "POST /api/loop/stop":
        try {
          // Send response first, then stop (which will exit the process)
          this.json(res, 200, { state: LoopState.STOPPED, message: "Stopping gracefully" });
          // Use setImmediate to ensure response is sent before process exits
          setImmediate(() => {
            this.orc.stop(true); // user-initiated: suppress auto-start on restart
          });
        } catch (err) {
          const message = err instanceof Error ? err.message : "Unknown error";
          this.json(res, 409, { error: message });
        }
        break;

      case "POST /api/conversation/send":
        this.handleConversationSend(req, res);
        break;

      case "POST /api/loop/restart":
        // Send response first, then restart (which will exit the process)
        this.json(res, 200, { success: true, message: "Restart requested — rebuilding" });
        // Use setImmediate to ensure response is sent before process exits
        setImmediate(() => {
          this.orc.requestRestart();
        });
        break;

      case "POST /api/loop/audit":
        this.orc.requestAudit();
        this.json(res, 200, { success: true });
        break;

      case "GET /api/reports/latest":
        this.handleReportsLatest(res);
        break;

      case "GET /api/reports":
        this.handleReportsList(res);
        break;

      case "GET /api/health":
        this.handleHealthCheck(res);
        break;

      case "GET /api/health/critical":
        this.handleCriticalHealthCheck(res);
        break;

      case "GET /api/substrate/health":
        this.handleSubstrateHealth(res);
        break;

      case "POST /api/backup":
        this.handleBackupRequest(res);
        break;

      case "POST /api/conversation/archive":
        this.handleArchiveRequest(res);
        break;

      case "POST /hooks/agent":
        this.handleAgoraWebhook(req, res);
        break;

      case "POST /api/canary/run":
        this.handleCanaryRun(res);
        break;

      default:
        this.json(res, 404, { error: "Not found" });
    }
  }

  private async handleMcpRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    try {
      const mcpServer = createTinyBusMcpServer({
        tinyBus: this.tinyBus!,
        agoraService: this.agoraService,
        ignoredPeersManager: this.agoraMessageHandler,
      });
      if (this.codeDispatcher) {
        addCodeDispatchTools(mcpServer, this.codeDispatcher);
      }
      const transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: undefined, // Stateless mode
      });
      await mcpServer.connect(transport);
      await transport.handleRequest(req, res);
      await mcpServer.close();
    } catch (error) {
      console.error("Error handling MCP request:", error);
      if (!res.headersSent) {
        this.json(res, 500, { error: String(error) });
      }
    }
  }

  private handleSubstrateRead(res: http.ServerResponse, fileTypeStr: string): void {
    if (!this.reader) {
      this.json(res, 500, { error: "Reader not configured" });
      return;
    }

    const fileType = SubstrateFileType[fileTypeStr as keyof typeof SubstrateFileType];
    if (!fileType) {
      this.json(res, 400, { error: `Invalid file type: ${fileTypeStr}` });
      return;
    }

    this.reader.read(fileType).then(
      (content) => this.json(res, 200, content),
      (err) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        if (message.includes("ENOENT") || message.includes("no such file")) {
          this.json(res, 404, { error: `File not found: ${fileTypeStr}` });
        } else {
          this.json(res, 500, { error: message });
        }
      }
    );
  }

  private handleConversationSend(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.ego) {
      this.json(res, 500, { error: "Ego not configured" });
      return;
    }

    let body = "";
    let bodyBytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > MAX_BODY_BYTES) {
        aborted = true;
        this.json(res, 413, { error: "Request body too large" });
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", () => {
      if (aborted) return;
      let parsed: { message?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        this.json(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!parsed.message || typeof parsed.message !== "string") {
        this.json(res, 400, { error: "Missing required field: message" });
        return;
      }

      this.ego!.appendConversation(parsed.message).then(
        () => {
          // Emit event so frontend updates immediately
          if (this.eventSink && this.clock) {
            this.eventSink.emit({
              type: "conversation_message",
              timestamp: this.clock.now().toISOString(),
              data: { role: "USER", message: parsed.message },
            });
          }
          // Fire-and-forget: route chat message through TinyBus
          if (this.tinyBus) {
            const chatMessage = createMessage({
              type: "chat",
              source: "ui",
              payload: { text: parsed.message },
            });
            this.tinyBus.publish(chatMessage).catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (this.eventSink && this.clock) {
                this.eventSink.emit({
                  type: "conversation_response",
                  timestamp: this.clock.now().toISOString(),
                  data: { error: errMsg },
                });
              }
            });
          } else {
            // Fallback to direct call if TinyBus not available
            this.orc.handleUserMessage(parsed.message!).catch((err) => {
              const errMsg = err instanceof Error ? err.message : String(err);
              if (this.eventSink && this.clock) {
                this.eventSink.emit({
                  type: "conversation_response",
                  timestamp: this.clock.now().toISOString(),
                  data: { error: errMsg },
                });
              }
            });
          }
          this.json(res, 200, { success: true });
        },
        (err) => {
          const message = err instanceof Error ? err.message : "Unknown error";
          this.json(res, 500, { error: message });
        }
      );
    });
  }

  private handleReportsLatest(res: http.ServerResponse): void {
    if (!this.reportStore) {
      this.json(res, 500, { error: "Report store not configured" });
      return;
    }
    this.reportStore.latest().then(
      (report) => {
        if (report) {
          this.json(res, 200, report);
        } else {
          this.json(res, 404, { error: "No reports found" });
        }
      },
      (err) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.json(res, 500, { error: message });
      }
    );
  }

  private handleReportsList(res: http.ServerResponse): void {
    if (!this.reportStore) {
      this.json(res, 500, { error: "Report store not configured" });
      return;
    }
    this.reportStore.list().then(
      (reports) => this.json(res, 200, reports),
      (err) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.json(res, 500, { error: message });
      }
    );
  }

  private handleHealthCheck(res: http.ServerResponse): void {
    if (!this.healthCheck) {
      this.json(res, 500, { error: "Health check not configured" });
      return;
    }
    this.healthCheck.run().then(
      (result) => this.json(res, 200, result),
      (err) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.json(res, 500, { error: message });
      }
    );
  }

  private async handleCriticalHealthCheck(res: http.ServerResponse): Promise<void> {
    if (!this.healthCheck || !this.orchestrator || !this.clock) {
      this.json(res, 503, { status: "unhealthy", error: "Not configured" });
      return;
    }

    try {
      const criticalResult = await this.healthCheck.runCriticalChecks();
      const state = this.orchestrator.getState();
      const { lastCycleAt, lastCycleResult } = this.orchestrator.getLastCycleDiagnostics();

      const now = this.clock.now();
      const lastCycleAgeMs = lastCycleAt !== null ? now.getTime() - lastCycleAt.getTime() : null;
      const STALE_CYCLE_THRESHOLD_MS = 5 * 60 * 1000; // 5 minutes

      const orchestratorHealthy = state === LoopState.RUNNING;
      const cycleAgeHealthy = lastCycleAgeMs === null || lastCycleAgeMs < STALE_CYCLE_THRESHOLD_MS;

      const healthy =
        criticalResult.healthy &&
        orchestratorHealthy &&
        cycleAgeHealthy &&
        criticalResult.substrateFsWritable === "healthy";

      const body = {
        status: healthy ? "healthy" : "unhealthy",
        checks: {
          orchestrator: orchestratorHealthy ? "healthy" : "unhealthy",
          substrateFsWritable: criticalResult.substrateFsWritable,
          lastCycleAgeMs,
          lastCycleResult,
          consecutiveAuditFailures: this.orchestrator.getMetrics().consecutiveAuditFailures,
        },
        version: getVersionInfo().version,
        timestamp: now.toISOString(),
      };

      this.json(res, healthy ? 200 : 503, body);
    } catch {
      this.json(res, 503, { status: "unhealthy", error: "Health check failed" });
    }
  }

  /**
   * Determine task classifier health status based on tactical routing percentage.
   * Target: 70-80% tactical routing for optimal cost efficiency.
   */
  private getTaskClassifierStatus(tacticalPct: number): "OK" | "WARNING" | "CRITICAL" {
    const TARGET_MIN = 0.7;  // 70% tactical minimum
    const TARGET_MAX = 0.8;  // 80% tactical maximum
    const WARNING_MIN = 0.6; // 60% tactical warning threshold

    if (tacticalPct >= TARGET_MIN && tacticalPct <= TARGET_MAX) {
      return "OK";
    }
    if (tacticalPct >= WARNING_MIN) {
      return "WARNING";
    }
    return "CRITICAL";
  }

  private async handleSubstrateHealth(res: http.ServerResponse): Promise<void> {
    if (!this.taskMetrics || !this.sizeTracker || !this.delegationTracker || !this.clock) {
      this.json(res, 500, { error: "Metrics components not configured" });
      return;
    }

    try {
      // Get file size status
      const fileStatus = await this.sizeTracker.getCurrentStatus();

      // Get task classifier stats (last 7 days)
      const sevenDaysAgo = new Date(this.clock.now().getTime() - 7 * 24 * 60 * 60 * 1000);
      const classificationStats = await this.taskMetrics.getStats(sevenDaysAgo);

      // Get delegation status
      const delegationStatus = await this.delegationTracker.getDelegationStatus();

      // Determine overall health status
      let overallStatus: "HEALTHY" | "WARNING" | "CRITICAL" = "HEALTHY";
      const alerts: string[] = [];

      // Check file sizes
      for (const [filename, status] of Object.entries(fileStatus)) {
        if (status.status === "CRITICAL") {
          overallStatus = "CRITICAL";
          alerts.push(`${filename} exceeds target by ${status.alert} (${status.current}/${status.target} lines)`);
        } else if (status.status === "WARNING" && overallStatus !== "CRITICAL") {
          overallStatus = "WARNING";
          alerts.push(`${filename} approaching target limit: ${status.alert}`);
        }
      }

      // Check delegation ratio
      if (delegationStatus) {
        if (delegationStatus.status === "CRITICAL") {
          overallStatus = "CRITICAL";
          if (delegationStatus.alert) {
            alerts.push(delegationStatus.alert);
          }
        } else if (delegationStatus.status === "WARNING" && overallStatus !== "CRITICAL") {
          overallStatus = "WARNING";
          if (delegationStatus.alert) {
            alerts.push(delegationStatus.alert);
          }
        }
      }

      // Build response
      const response = {
        timestamp: this.clock.now().toISOString(),
        status: overallStatus,
        files: fileStatus,
        delegation: delegationStatus ? {
          ratio: delegationStatus.ratio,
          copilot_issues: delegationStatus.copilot_issues,
          total_issues: delegationStatus.total_issues,
          status: delegationStatus.status,
        } : null,
        taskClassifier: {
          strategic_pct: classificationStats.strategicPct,
          tactical_pct: classificationStats.tacticalPct,
          status: this.getTaskClassifierStatus(classificationStats.tacticalPct),
          total_operations: classificationStats.totalOperations,
        },
        lastCompaction: this.conversationManager?.getLastMaintenanceTime()?.toISOString() ?? null,
        alerts,
      };

      this.json(res, 200, response);
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.json(res, 500, { error: message });
    }
  }

  private handleBackupRequest(res: http.ServerResponse): void {
    if (!this.backupScheduler) {
      this.json(res, 503, { error: "Backup scheduler not configured" });
      return;
    }
    this.backupScheduler.runBackup().then(
      (result) => {
        if (result.success) {
          this.json(res, 200, {
            success: true,
            backupPath: result.backupPath,
            verified: result.verification?.valid ?? false,
            checksum: result.verification?.checksum,
            sizeBytes: result.verification?.sizeBytes,
            timestamp: result.timestamp,
          });
        } else {
          this.json(res, 500, { success: false, error: result.error, timestamp: result.timestamp });
        }
      },
      (err) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.json(res, 500, { error: message });
      }
    );
  }

  private handleArchiveRequest(res: http.ServerResponse): void {
    if (!this.conversationManager) {
      this.json(res, 503, { error: "Conversation archiving is not enabled" });
      return;
    }
    this.conversationManager.forceArchive().then(
      (result) => {
        if (result.success) {
          this.json(res, 200, {
            success: true,
            linesArchived: result.linesArchived,
            archivedPath: result.archivedPath,
          });
        } else {
          // Archive not configured or nothing to archive
          this.json(res, 200, { 
            success: false, 
            linesArchived: 0,
            message: "Archiving is not enabled or no content to archive" 
          });
        }
      },
      (err) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.json(res, 500, { error: message });
      }
    );
  }

  /**
   * Handle Agora webhook requests.
   * Decodes the envelope and delegates processing to AgoraMessageHandler.
   */
  private handleAgoraWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.agoraService || !this.agoraMessageHandler) {
      this.logger?.debug("[AGORA] Webhook rejected: Agora service not configured");
      this.json(res, 503, { error: "Agora service not configured" });
      return;
    }

    // If AGORA_WEBHOOK_TOKEN is configured, validate the Bearer token; otherwise trust Ed25519 alone
    const webhookToken = this.agoraWebhookToken;
    if (webhookToken) {
      const authHeader = req.headers.authorization;
      const expectedBearer = `Bearer ${webhookToken}`;
      const provided = Buffer.from(authHeader ?? "");
      const expected = Buffer.from(expectedBearer);
      const valid =
        provided.length === expected.length &&
        crypto.timingSafeEqual(provided, expected);
      if (!valid) {
        this.logger?.debug("[AGORA] Webhook rejected: Invalid or missing Authorization header");
        this.json(res, 401, { error: "Invalid or missing Authorization header" });
        return;
      }
    }

    let body = "";
    let bodyBytes = 0;
    let aborted = false;
    req.on("data", (chunk: Buffer) => {
      bodyBytes += chunk.byteLength;
      if (bodyBytes > MAX_BODY_BYTES) {
        aborted = true;
        this.json(res, 413, { error: "Request body too large" });
        req.destroy();
        return;
      }
      body += chunk.toString();
    });
    req.on("end", async () => {
      if (aborted) return;
      this.logger?.debug(`[AGORA] Webhook received: bodyLength=${body.length}`);
      
      let parsed: { message?: string };
      try {
        parsed = JSON.parse(body);
      } catch {
        this.logger?.debug("[AGORA] Webhook rejected: Invalid JSON");
        this.json(res, 400, { error: "Invalid JSON" });
        return;
      }

      if (!parsed.message || typeof parsed.message !== "string") {
        this.logger?.debug("[AGORA] Webhook rejected: Missing required field: message");
        this.json(res, 400, { error: "Missing required field: message" });
        return;
      }

      try {
        this.logger?.debug(`[AGORA] Decoding inbound envelope: messageLength=${parsed.message.length}`);
        
        // Decode and verify the inbound envelope
        const result = await this.agoraService!.decodeInbound(parsed.message);

        if (!result.ok) {
          this.logger?.debug(`[AGORA] Webhook rejected: Invalid envelope: ${result.reason}`);
          this.json(res, 400, { error: `Invalid envelope: ${result.reason}` });
          return;
        }

        this.logger?.debug(`[AGORA] Envelope decoded successfully: envelopeId=${result.envelope!.id} type=${result.envelope!.type}`);

        // SECURITY: Verify signature before processing
        // Dynamic import required because @rookdaemon/agora is ESM-only;
        // getAgoraModule() caches the result after the first call.
        const agora = await getAgoraModule();
        const verifyResult = agora.verifyEnvelope(result.envelope!);
        if (!verifyResult.valid) {
          this.logger?.debug(`[AGORA] Webhook rejected: Invalid envelope signature: ${verifyResult.reason ?? "unknown"}`);
          this.json(res, 400, { error: `Invalid envelope signature: ${verifyResult.reason ?? "unknown"}` });
          return;
        }

        this.logger?.debug(`[AGORA] Envelope signature verified: envelopeId=${result.envelope!.id}`);

        // Process the message via AgoraMessageHandler
        const status = await this.agoraMessageHandler!.processEnvelope(result.envelope!, "webhook");

        this.logger?.debug(`[AGORA] Webhook processed successfully: envelopeId=${result.envelope!.id} status=${status}`);
        this.json(res, 200, { accepted: true, envelopeId: result.envelope!.id, status });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.logger?.debug(`[AGORA] Webhook error: ${message}`);
        this.json(res, 500, { error: message });
      }
    });
  }

  private handleCanaryRun(res: http.ServerResponse): void {
    if (!this.canaryId || !this.canaryLogger || !this.clock) {
      this.json(res, 503, { error: "Canary route not configured" });
      return;
    }

    const now = this.clock.now().getTime();
    if (this.canaryLastRunAt !== null) {
      const elapsed = now - this.canaryLastRunAt;
      if (elapsed < LoopHttpServer.CANARY_RATE_LIMIT_MS) {
        const retryAfterSec = Math.ceil((LoopHttpServer.CANARY_RATE_LIMIT_MS - elapsed) / 1000);
        res.setHeader("Retry-After", String(retryAfterSec));
        this.json(res, 429, { error: "Rate limited", retryAfterSeconds: retryAfterSec });
        return;
      }
    }

    this.canaryLastRunAt = now;

    const id = this.canaryId;
    const canaryLogger = this.canaryLogger;
    const launcherName = this.canaryLauncherName;
    const clock = this.clock;
    const convMdReader = this.convMdReader;

    Promise.all([
      id.generateDrives(),
      convMdReader ? convMdReader().catch(() => null) : Promise.resolve(null),
      canaryLogger.nextApiCycle(),
    ]).then(([{ candidates, parseErrors }, convStats, cycle]) => {
      const highPriority = candidates.filter((c) => c.priority === "high");
      const highPriorityConfidence = highPriority.length > 0
        ? Math.round(highPriority.reduce((sum, c) => sum + c.confidence, 0) / highPriority.length)
        : null;
      const record = {
        timestamp: clock.now().toISOString(),
        cycle,
        launcher: launcherName,
        candidateCount: candidates.length,
        highPriorityConfidence,
        parseErrors,
        pass: parseErrors === 0 && candidates.length > 0,
        trigger: "api" as const,
        ...(convStats !== null ? { convMdLines: convStats.lines, convMdKb: convStats.kb } : {}),
      };
      return canaryLogger.recordCycle(record);
    }).then(
      (enriched) => this.json(res, 200, enriched),
      (err) => {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.json(res, 500, { error: message });
      }
    );
  }

  private tryStateTransition(res: http.ServerResponse, fn: () => void): void {
    try {
      fn();
      this.json(res, 200, { state: this.orc.getState() });
    } catch (err) {
      const message = err instanceof Error ? err.message : "Unknown error";
      this.json(res, 409, { error: message });
    }
  }

  private json(res: http.ServerResponse, status: number, body: unknown): void {
    res.writeHead(status, { "Content-Type": "application/json" });
    res.end(JSON.stringify(body));
  }
}
