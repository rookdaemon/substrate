import * as http from "node:http";
import { LoopOrchestrator } from "./LoopOrchestrator";
import { ILoopEventSink } from "./ILoopEventSink";
import { IClock } from "../substrate/abstractions/IClock";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileType } from "../substrate/types";
import { Ego } from "../agents/roles/Ego";
import { GovernanceReportStore } from "../evaluation/GovernanceReportStore";
import { HealthCheck } from "../evaluation/HealthCheck";
import { AgoraService, type Envelope } from "@rookdaemon/agora";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";
import { BackupScheduler } from "./BackupScheduler";
import { ConversationManager } from "../conversation/ConversationManager";
import { AgoraInboxManager } from "../agora/AgoraInboxManager";
import { TaskClassificationMetrics } from "../evaluation/TaskClassificationMetrics";
import { SubstrateSizeTracker } from "../evaluation/SubstrateSizeTracker";
import { DelegationTracker } from "../evaluation/DelegationTracker";
import { shortKey } from "../agora/utils";

export interface LoopHttpDependencies {
  reader: SubstrateFileReader;
  ego: Ego;
}

export class LoopHttpServer {
  private server: http.Server;
  private orchestrator: LoopOrchestrator;
  private reader: SubstrateFileReader | null = null;
  private ego: Ego | null = null;
  private reportStore: GovernanceReportStore | null = null;
  private healthCheck: HealthCheck | null = null;
  private eventSink: ILoopEventSink | null = null;
  private clock: IClock | null = null;
  private mode: "cycle" | "tick" = "cycle";
  private agoraService: AgoraService | null = null;
  private appendWriter: AppendOnlyWriter | null = null;
  private backupScheduler: BackupScheduler | null = null;
  private conversationManager: ConversationManager | null = null;
  private agoraInboxManager: AgoraInboxManager | null = null;
  private taskMetrics: TaskClassificationMetrics | null = null;
  private sizeTracker: SubstrateSizeTracker | null = null;
  private delegationTracker: DelegationTracker | null = null;

  constructor(orchestrator: LoopOrchestrator) {
    this.orchestrator = orchestrator;
    this.server = http.createServer((req, res) => this.handleRequest(req, res));
  }

  setOrchestrator(orchestrator: LoopOrchestrator): void {
    this.orchestrator = orchestrator;
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

  setAgoraService(service: AgoraService, appendWriter: AppendOnlyWriter, inboxManager: AgoraInboxManager): void {
    this.agoraService = service;
    this.appendWriter = appendWriter;
    this.agoraInboxManager = inboxManager;
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

  listen(port: number): Promise<number> {
    return new Promise((resolve) => {
      this.server.listen(port, "127.0.0.1", () => {
        const addr = this.server.address();
        const boundPort = typeof addr === "object" && addr ? addr.port : port;
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
          state: this.orchestrator.getState(),
          metrics: this.orchestrator.getMetrics(),
        };
        const rlu = this.orchestrator.getRateLimitUntil();
        if (rlu) statusPayload.rateLimitUntil = rlu;
        this.json(res, 200, statusPayload);
        break;
      }

      case "GET /api/loop/metrics":
        this.json(res, 200, this.orchestrator.getMetrics());
        break;

      case "POST /api/loop/start":
        this.tryStateTransition(res, () => {
          this.orchestrator.start();
          // Fire-and-forget: start the loop without awaiting
          if (this.mode === "tick") {
            this.orchestrator.runTickLoop().catch(() => {});
          } else {
            this.orchestrator.runLoop().catch(() => {});
          }
        });
        break;

      case "POST /api/loop/pause":
        this.tryStateTransition(res, () => this.orchestrator.pause());
        break;

      case "POST /api/loop/resume":
        this.tryStateTransition(res, () => this.orchestrator.resume());
        break;

      case "POST /api/loop/stop":
        this.tryStateTransition(res, () => this.orchestrator.stop());
        break;

      case "POST /api/conversation/send":
        this.handleConversationSend(req, res);
        break;

      case "POST /api/loop/restart":
        this.orchestrator.requestRestart();
        this.json(res, 200, { success: true, message: "Restart requested — rebuilding" });
        break;

      case "POST /api/loop/audit":
        this.orchestrator.requestAudit();
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

      default:
        this.json(res, 404, { error: "Not found" });
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
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", () => {
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
          // Fire-and-forget: launch a separate Ego session to respond
          this.orchestrator.handleUserMessage(parsed.message!).catch((err) => {
            const errMsg = err instanceof Error ? err.message : String(err);
            if (this.eventSink && this.clock) {
              this.eventSink.emit({
                type: "conversation_response",
                timestamp: this.clock.now().toISOString(),
                data: { error: errMsg },
              });
            }
          });
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
        lastCompaction: null, // TODO: Get from ConversationManager or PROGRESS.md
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
   * Shared method to process inbound Agora messages.
   * Called by webhook handler and future relay client (see rookdaemon/substrate#28).
   * 
   * Message processing pipeline:
   * 1. Log to PROGRESS.md
   * 2. Persist to AGORA_INBOX.md (structured queue with Unread/Read sections)
   * 3. Emit WebSocket event for frontend visibility
   * 4. Inject into agent loop via injectMessage()
   * 
   * When the relay client is implemented, it should call this same method
   * to ensure consistent message handling across delivery mechanisms.
   */
  private async processInboundAgoraMessage(envelope: Envelope): Promise<void> {
    if (!this.appendWriter || !this.clock || !this.agoraInboxManager) {
      throw new Error("Required dependencies not configured for Agora message processing");
    }

    const timestamp = this.clock.now().toISOString();
    const senderShort = shortKey(envelope.sender);

    // 1. Log to PROGRESS.md
    const logEntry = `[AGORA] Received ${envelope.type} from ${senderShort} — payload: ${JSON.stringify(envelope.payload)}`;
    await this.appendWriter.append(SubstrateFileType.PROGRESS, logEntry);

    // 2. Persist to AGORA_INBOX.md
    await this.agoraInboxManager.addMessage(envelope);

    // 3. Emit WebSocket event for frontend visibility
    if (this.eventSink) {
      this.eventSink.emit({
        type: "agora_message",
        timestamp,
        data: {
          envelopeId: envelope.id,
          messageType: envelope.type,
          sender: envelope.sender,
          payload: envelope.payload,
        },
      });
    }

    // 4. Inject into agent loop
    if (this.orchestrator) {
      const agentPrompt = `[AGORA MESSAGE from ${senderShort}]\nType: ${envelope.type}\nEnvelope ID: ${envelope.id}\nPayload: ${JSON.stringify(envelope.payload)}\n\nRespond to this message if appropriate. Use AgoraService.send() to reply.`;
      this.orchestrator.injectMessage(agentPrompt);
    }
  }

  private handleAgoraWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.agoraService || !this.appendWriter || !this.clock || !this.agoraInboxManager) {
      this.json(res, 503, { error: "Agora service not configured" });
      return;
    }

    // Check Authorization header for Bearer token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      this.json(res, 401, { error: "Missing or invalid Authorization header" });
      return;
    }

    let body = "";
    req.on("data", (chunk: Buffer) => { body += chunk.toString(); });
    req.on("end", async () => {
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

      try {
        // Decode and verify the inbound envelope
        const result = await this.agoraService!.decodeInbound(parsed.message);

        if (!result.ok) {
          this.json(res, 400, { error: `Invalid envelope: ${result.reason}` });
          return;
        }

        // Process the message using shared method
        await this.processInboundAgoraMessage(result.envelope!);

        this.json(res, 200, { success: true, envelopeId: result.envelope!.id });
      } catch (err) {
        const message = err instanceof Error ? err.message : "Unknown error";
        this.json(res, 500, { error: message });
      }
    });
  }

  private tryStateTransition(res: http.ServerResponse, fn: () => void): void {
    try {
      fn();
      this.json(res, 200, { state: this.orchestrator.getState() });
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
