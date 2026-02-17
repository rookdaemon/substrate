import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import { AgoraService, type AgoraServiceConfig } from "@rookdaemon/agora";
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
import { LoopState } from "../../src/loop/types";
import * as http from "http";

describe("Agora Message Integration", () => {
  let httpServer: LoopHttpServer;
  let orchestrator: LoopOrchestrator;
  let agoraService: AgoraService;
  let agoraMessageHandler: AgoraMessageHandler;
  let fs: InMemoryFileSystem;
  let clock: FixedClock;
  let config: SubstrateConfig;
  let lock: FileLock;
  let appendWriter: AppendOnlyWriter;
  let conversationManager: ConversationManager;
  let injectedMessages: string[];

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

  beforeEach(async () => {
    fs = new InMemoryFileSystem();
    clock = new FixedClock(new Date("2026-02-15T12:00:00Z"));
    config = new SubstrateConfig("/test/substrate");
    lock = new FileLock();

    // Initialize PROGRESS.md
    const progressPath = config.getFilePath(SubstrateFileType.PROGRESS);
    await fs.writeFile(progressPath, "# Progress\n\n");

    // Initialize CONVERSATION.md
    const conversationPath = config.getFilePath(SubstrateFileType.CONVERSATION);
    await fs.writeFile(conversationPath, "# Conversation\n\n");

    appendWriter = new AppendOnlyWriter(fs, config, lock, clock);
    agoraService = new AgoraService(testAgoraConfig);

    // Set up conversation manager
    const reader = new SubstrateFileReader(fs, config);
    const checker = new PermissionChecker();
    const compactor = new ConversationCompactor(
      {
        launch: async () => ({ success: true, rawOutput: "" }),
      } as ISessionLauncher,
      undefined
    );
    conversationManager = new ConversationManager(
      reader,
      fs,
      config,
      lock,
      appendWriter,
      checker,
      compactor,
      clock
    );

    // Track injected messages
    injectedMessages = [];

    // Create a mock orchestrator that tracks message injection
    orchestrator = {
      injectMessage: (msg: string) => {
        injectedMessages.push(msg);
      },
      getState: () => LoopState.RUNNING,
    } as unknown as LoopOrchestrator;

    // Create event sink mock
    const eventSink = {
      emit: () => {
        /* no-op for testing */
      },
    };

    // Create AgoraMessageHandler
    agoraMessageHandler = new AgoraMessageHandler(
      agoraService,
      conversationManager,
      orchestrator,
      eventSink,
      clock,
      () => orchestrator.getState()
    );

    httpServer = new LoopHttpServer(orchestrator);
    httpServer.setOrchestrator(orchestrator);
    httpServer.setEventSink(eventSink, clock);
    httpServer.setAgoraMessageHandler(agoraMessageHandler, agoraService);
  });

  it("should process webhook message and inject into agent loop", async () => {
    // Simulate a webhook request
    const port = await httpServer.listen(0); // Random port

    // Create a valid Agora envelope (simplified - in reality would be signed)
    const envelopeMessage = "[AGORA_ENVELOPE]test-base64-message";

    // Mock decodeInbound to return a valid envelope
    const decodeInboundSpy = jest.spyOn(agoraService, "decodeInbound");
    decodeInboundSpy.mockResolvedValue({
      ok: true,
      envelope: {
        id: "msg-123",
        type: "request",
        sender: "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd",
        timestamp: 1708000000000,
        payload: { question: "Hello, are you there?" },
        signature: "test-signature",
      },
    });

    // Send HTTP POST to webhook endpoint
    const result = await sendWebhookRequest(port, envelopeMessage);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ success: true, envelopeId: "msg-123" });

    // Verify message was injected into agent loop
    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0]).toContain("[AGORA MESSAGE from ...cdefabcd]");
    expect(injectedMessages[0]).toContain("Type: request");
    expect(injectedMessages[0]).toContain("Envelope ID: msg-123");
    expect(injectedMessages[0]).toContain('"question":"Hello, are you there?"');

    // Verify message was written to CONVERSATION.md
    const conversationPath = config.getFilePath(SubstrateFileType.CONVERSATION);
    const conversationContent = await fs.readFile(conversationPath);
    expect(conversationContent).toContain("[AGORA]");
    expect(conversationContent).toContain("Envelope: msg-123");
    expect(conversationContent).toContain("Type: request");
    expect(conversationContent).toContain("From: ...cdefabcd");

    await httpServer.close();
  });

  it("should reject webhook without authorization header", async () => {
    const port = await httpServer.listen(0);

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]test", false);

    expect(result.statusCode).toBe(401);
    expect(result.body).toMatchObject({ error: "Missing or invalid Authorization header" });

    await httpServer.close();
  });

  it("should handle multiple messages in order", async () => {
    const port = await httpServer.listen(0);

    // Mock decodeInbound to return different envelopes
    let callCount = 0;
    jest.spyOn(agoraService, "decodeInbound").mockImplementation(async () => {
      callCount++;
      return {
        ok: true,
        envelope: {
          id: `msg-${callCount}`,
          type: "announce",
          sender: `sender-${callCount}`,
          timestamp: 1708000000000 + callCount,
          payload: { data: `message ${callCount}` },
          signature: "test-signature",
        },
      };
    });

    // Send two messages
    await sendWebhookRequest(port, "[AGORA_ENVELOPE]msg1");
    clock.setNow(new Date("2026-02-15T12:01:00Z"));
    await sendWebhookRequest(port, "[AGORA_ENVELOPE]msg2");

    expect(injectedMessages).toHaveLength(2);
    expect(injectedMessages[0]).toContain("msg-1");
    expect(injectedMessages[1]).toContain("msg-2");

    // Verify both in CONVERSATION.md
    const conversationPath = config.getFilePath(SubstrateFileType.CONVERSATION);
    const conversationContent = await fs.readFile(conversationPath);
    expect(conversationContent).toContain("Envelope: msg-1");
    expect(conversationContent).toContain("Envelope: msg-2");

    await httpServer.close();
  });
});

// Helper function to send webhook request
async function sendWebhookRequest(
  port: number,
  message: string,
  withAuth = true
): Promise<{ statusCode: number; body: { success?: boolean; envelopeId?: string; error?: string } }> {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify({ message });
    const options = {
      hostname: "127.0.0.1",
      port,
      path: "/hooks/agent",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": data.length,
        ...(withAuth && { Authorization: "Bearer test-token" }),
      },
    };

    const req = http.request(options, (res) => {
      let body = "";
      res.on("data", (chunk) => {
        body += chunk;
      });
      res.on("end", () => {
        resolve({
          statusCode: res.statusCode || 0,
          body: JSON.parse(body),
        });
      });
    });

    req.on("error", reject);
    req.write(data);
    req.end();
  });
}
