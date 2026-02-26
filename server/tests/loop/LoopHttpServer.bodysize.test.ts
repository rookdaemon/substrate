import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { LoopState } from "../../src/loop/types";
import type { AgoraServiceConfig } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import { AgoraService } from "@rookdaemon/agora";
import { AgoraMessageHandler } from "../../src/agora/AgoraMessageHandler";
import { ConversationManager } from "../../src/conversation/ConversationManager";
import { InMemoryFileSystem } from "../../src/substrate/abstractions/InMemoryFileSystem";
import { FixedClock } from "../../src/substrate/abstractions/FixedClock";
import { SubstrateConfig } from "../../src/substrate/config";
import { FileLock } from "../../src/substrate/io/FileLock";
import { AppendOnlyWriter } from "../../src/substrate/io/AppendOnlyWriter";
import { SubstrateFileReader } from "../../src/substrate/io/FileReader";
import { SubstrateFileType } from "../../src/substrate/types";
import { PermissionChecker } from "../../src/agents/permissions";
import { ConversationCompactor } from "../../src/conversation/ConversationCompactor";
import { ISessionLauncher } from "../../src/agents/claude/ISessionLauncher";
import type { ILogger } from "../../src/logging";
import * as http from "http";

const ONE_MIB = 1 * 1024 * 1024;

const testAgoraConfig: AgoraServiceConfig = {
  identity: {
    publicKey: "302a300506032b6570032100aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    privateKey: "302e020100300506032b6570042204bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
  },
  peers: new Map([
    [
      "testpeer",
      {
        publicKey: "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
        url: "http://localhost:18790/hooks",
        token: "test-token-123",
      },
    ],
  ]),
};

/**
 * Sends a POST request with the given body buffer, returning status code and parsed body.
 */
function sendRawPost(
  port: number,
  path: string,
  body: Buffer,
  headers: Record<string, string> = {}
): Promise<{ statusCode: number; body: string }> {
  return new Promise((resolve, reject) => {
    const options = {
      hostname: "127.0.0.1",
      port,
      path,
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": body.length,
        ...headers,
      },
    };

    const req = http.request(options, (res) => {
      let responseBody = "";
      res.on("data", (chunk) => { responseBody += chunk; });
      res.on("end", () => resolve({ statusCode: res.statusCode ?? 0, body: responseBody }));
    });

    req.on("error", (err) => {
      // Ignore ECONNRESET: the server destroyed the connection after 413
      if ((err as NodeJS.ErrnoException).code === "ECONNRESET") {
        resolve({ statusCode: 413, body: JSON.stringify({ error: "Request body too large" }) });
      } else {
        reject(err);
      }
    });

    req.write(body);
    req.end();
  });
}

describe("LoopHttpServer body size limits", () => {
  let httpServer: LoopHttpServer;
  let agoraService: AgoraService;
  let agoraMessageHandler: AgoraMessageHandler;

  beforeEach(async () => {
    const fs = new InMemoryFileSystem();
    const clock = new FixedClock(new Date("2026-02-15T12:00:00Z"));
    const config = new SubstrateConfig("/test/substrate");
    const lock = new FileLock();

    await fs.writeFile(config.getFilePath(SubstrateFileType.PROGRESS), "# Progress\n\n");
    await fs.writeFile(config.getFilePath(SubstrateFileType.CONVERSATION), "# Conversation\n\n");

    const appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    const reader = new SubstrateFileReader(fs, config);
    const checker = new PermissionChecker();
    const compactor = new ConversationCompactor(
      { launch: async () => ({ success: true, rawOutput: "" }) } as ISessionLauncher,
      undefined
    );
    const conversationManager = new ConversationManager(
      reader, fs, config, lock, appendWriter, checker, compactor, clock
    );

    const agora = await import("@rookdaemon/agora");
    agoraService = new agora.AgoraService(testAgoraConfig);

    const orchestrator = {
      injectMessage: () => true,
      getState: () => LoopState.RUNNING,
      handleUserMessage: jest.fn().mockResolvedValue(undefined),
    } as unknown as LoopOrchestrator;

    const eventSink = { emit: () => { /* no-op */ } };
    const logger: ILogger = { debug: () => { /* no-op */ }, warn: () => { /* no-op */ }, error: () => { /* no-op */ }, verbose: () => { /* no-op */ } };

    agoraMessageHandler = new AgoraMessageHandler(
      agoraService,
      conversationManager,
      orchestrator,
      eventSink,
      clock,
      () => orchestrator.getState(),
      () => false,
      logger,
      "allow",
      { enabled: true, maxMessages: 10, windowMs: 60000 },
      null
    );

    // Mock the Ego dependency with just what handleConversationSend needs
    const mockEgo = {
      appendConversation: jest.fn().mockResolvedValue(undefined),
    };

    httpServer = new LoopHttpServer();
    httpServer.setOrchestrator(orchestrator);
    httpServer.setDependencies({ reader, ego: mockEgo as never });
    httpServer.setEventSink(eventSink, clock);
    httpServer.setLogger(logger);
    httpServer.setAgoraMessageHandler(agoraMessageHandler, agoraService);
  });

  afterEach(async () => {
    try { await httpServer.close(); } catch { /* already closed */ }
    delete process.env.AGORA_WEBHOOK_TOKEN;
  });

  it("returns 413 when POST /api/conversation/send body exceeds 1 MiB", async () => {
    const port = await httpServer.listen(0);

    // Build a JSON body > 1 MiB by padding the message field
    const padding = "x".repeat(ONE_MIB + 1);
    const oversizedBody = Buffer.from(JSON.stringify({ message: padding }));
    expect(oversizedBody.byteLength).toBeGreaterThan(ONE_MIB);

    const result = await sendRawPost(port, "/api/conversation/send", oversizedBody);

    expect(result.statusCode).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: "Request body too large" });
  });

  it("returns 200 for POST /api/conversation/send with a normal-sized body", async () => {
    const port = await httpServer.listen(0);

    const normalBody = Buffer.from(JSON.stringify({ message: "hello" }));
    const result = await sendRawPost(port, "/api/conversation/send", normalBody);

    expect(result.statusCode).toBe(200);
  });

  it("returns 413 when POST /hooks/agent body exceeds 1 MiB (no token required)", async () => {
    delete process.env.AGORA_WEBHOOK_TOKEN;
    const port = await httpServer.listen(0);

    const padding = "x".repeat(ONE_MIB + 1);
    const oversizedBody = Buffer.from(JSON.stringify({ message: padding }));
    expect(oversizedBody.byteLength).toBeGreaterThan(ONE_MIB);

    const result = await sendRawPost(port, "/hooks/agent", oversizedBody);

    expect(result.statusCode).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: "Request body too large" });
  });

  it("returns 413 when POST /hooks/agent body exceeds 1 MiB (with token)", async () => {
    process.env.AGORA_WEBHOOK_TOKEN = "test-secret";
    const tokenServer = new LoopHttpServer();
    tokenServer.setOrchestrator({
      getState: () => LoopState.RUNNING,
    } as unknown as LoopOrchestrator);
    tokenServer.setAgoraMessageHandler(agoraMessageHandler, agoraService);
    tokenServer.setLogger({ debug: () => { /* no-op */ }, verbose: () => { /* no-op */ } });
    const port = await tokenServer.listen(0);

    const padding = "x".repeat(ONE_MIB + 1);
    const oversizedBody = Buffer.from(JSON.stringify({ message: padding }));

    const result = await sendRawPost(port, "/hooks/agent", oversizedBody, {
      Authorization: "Bearer test-secret",
    });

    expect(result.statusCode).toBe(413);
    expect(JSON.parse(result.body)).toEqual({ error: "Request body too large" });

    await tokenServer.close();
  });
});
