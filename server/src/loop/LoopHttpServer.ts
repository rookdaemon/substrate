import * as http from "node:http";
import { LoopOrchestrator } from "./LoopOrchestrator";
import { ILoopEventSink } from "./ILoopEventSink";
import { IClock } from "../substrate/abstractions/IClock";
import { SubstrateFileReader } from "../substrate/io/FileReader";
import { SubstrateFileType } from "../substrate/types";
import { Ego } from "../agents/roles/Ego";
import { GovernanceReportStore } from "../evaluation/GovernanceReportStore";
import { HealthCheck } from "../evaluation/HealthCheck";
import { AgoraService } from "../agora/AgoraService";
import { AppendOnlyWriter } from "../substrate/io/AppendOnlyWriter";

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

  setAgoraService(service: AgoraService, appendWriter: AppendOnlyWriter): void {
    this.agoraService = service;
    this.appendWriter = appendWriter;
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
      case "GET /api/loop/status":
        this.json(res, 200, {
          state: this.orchestrator.getState(),
          metrics: this.orchestrator.getMetrics(),
        });
        break;

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

  private handleAgoraWebhook(req: http.IncomingMessage, res: http.ServerResponse): void {
    if (!this.agoraService || !this.appendWriter || !this.clock) {
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

        // Log to PROGRESS.md
        const timestamp = this.clock!.now().toISOString();
        const logEntry = `[AGORA] Received ${result.envelope!.type} from ${result.envelope!.sender.substring(0, 8)}... — payload: ${JSON.stringify(result.envelope!.payload)}`;
        await this.appendWriter!.append(SubstrateFileType.PROGRESS, logEntry);

        // Emit WebSocket event for frontend visibility
        if (this.eventSink) {
          this.eventSink.emit({
            type: "agora_message",
            timestamp,
            data: {
              envelopeId: result.envelope!.id,
              messageType: result.envelope!.type,
              sender: result.envelope!.sender,
              payload: result.envelope!.payload,
            },
          });
        }

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
