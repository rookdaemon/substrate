import { LoopHttpServer } from "../../src/loop/LoopHttpServer";
import { LoopOrchestrator } from "../../src/loop/LoopOrchestrator";
import type { AgoraServiceConfig, Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
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
import { LoopState } from "../../src/loop/types";
import type { ILogger } from "../../src/logging";
import * as http from "http";

describe("Agora Message Integration", () => {
  let httpServer: LoopHttpServer;
  let orchestrator: LoopOrchestrator;
  let agoraService: AgoraService; // AgoraService from dynamic import
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
    
    // Dynamically import and initialize AgoraService
    const agora = await import("@rookdaemon/agora");
    agoraService = new agora.AgoraService(testAgoraConfig);

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
        return true; // Simulate active session delivery
      },
      getState: () => LoopState.RUNNING,
    } as unknown as LoopOrchestrator;

    // Create event sink mock
    const eventSink = {
      emit: () => {
        /* no-op for testing */
      },
    };

    // Create logger mock
    const logger: ILogger = {
      debug: () => {
        /* no-op for testing */
      },
      verbose: () => {
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
      () => orchestrator.getState(),
      () => false,
      logger,
      'allow', // Allow all messages for integration tests
      {
        enabled: true,
        maxMessages: 10,
        windowMs: 60000,
      },
      null // No wakeLoop needed for integration tests
    );

    httpServer = new LoopHttpServer(orchestrator);
    httpServer.setOrchestrator(orchestrator);
    httpServer.setEventSink(eventSink, clock);
    httpServer.setLogger(logger);
    httpServer.setAgoraMessageHandler(agoraMessageHandler, agoraService);
  });

  it("should process webhook message and inject into agent loop", async () => {
    // Simulate a webhook request
    const port = await httpServer.listen(0); // Random port

    // Create a properly signed Agora envelope using testpeer's keys
    const agora = await import("@rookdaemon/agora");
    const testPeerPublicKey = "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const testPeerPrivateKey = "302e020100300506032b65700422044444444444444444444444444444444444444444444444444444444444444444444444";
    
    const validEnvelope = agora.createEnvelope(
      "request",
      testPeerPublicKey,
      testPeerPrivateKey,
      { question: "Hello, are you there?" },
      1708000000000
    );

    const envelopeMessage = "[AGORA_ENVELOPE]test-base64-message";

    // Mock decodeInbound to return the properly signed envelope
    const decodeInboundSpy = jest.spyOn(agoraService, "decodeInbound");
    decodeInboundSpy.mockResolvedValue({
      ok: true,
      envelope: validEnvelope,
    });

    // Send HTTP POST to webhook endpoint
    const result = await sendWebhookRequest(port, envelopeMessage);

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ success: true, envelopeId: validEnvelope.id });

    // Verify message was injected into agent loop
    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0]).toContain("[AGORA MESSAGE from");
    expect(injectedMessages[0]).toContain("...cccccccc]");
    expect(injectedMessages[0]).toContain("Type: request");
    expect(injectedMessages[0]).toContain(`Envelope ID: ${validEnvelope.id}`);
    expect(injectedMessages[0]).toContain('"question":"Hello, are you there?"');

    // Verify message was written to CONVERSATION.md
    const conversationPath = config.getFilePath(SubstrateFileType.CONVERSATION);
    const conversationContent = await fs.readFile(conversationPath);
    expect(conversationContent).toContain("...cccccccc");
    expect(conversationContent).toContain("request");
    expect(conversationContent).toContain("**question**:");
    expect(conversationContent).toContain("Hello, are you there?");

    await httpServer.close();
  });

  it("should allow webhook without authorization header when AGORA_WEBHOOK_TOKEN is not set", async () => {
    delete process.env.AGORA_WEBHOOK_TOKEN;
    const port = await httpServer.listen(0);

    const agora = await import("@rookdaemon/agora");
    const testPeerPublicKey = "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const testPeerPrivateKey = "302e020100300506032b65700422044444444444444444444444444444444444444444444444444444444444444444444444";
    const validEnvelope = agora.createEnvelope("request", testPeerPublicKey, testPeerPrivateKey, { q: "hi" }, 1708000000000);
    const decodeInboundSpy = jest.spyOn(agoraService, "decodeInbound").mockResolvedValue({ ok: true, envelope: validEnvelope });

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]test", false);

    expect(result.statusCode).toBe(200);
    expect(decodeInboundSpy).toHaveBeenCalledTimes(1);

    await httpServer.close();
  });

  it("should accept webhook with correct token when AGORA_WEBHOOK_TOKEN is set", async () => {
    process.env.AGORA_WEBHOOK_TOKEN = "secret-token";
    const port = await httpServer.listen(0);

    const agora = await import("@rookdaemon/agora");
    const testPeerPublicKey = "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const testPeerPrivateKey = "302e020100300506032b65700422044444444444444444444444444444444444444444444444444444444444444444444444";
    const validEnvelope = agora.createEnvelope("request", testPeerPublicKey, testPeerPrivateKey, { q: "hi" }, 1708000000000);
    jest.spyOn(agoraService, "decodeInbound").mockResolvedValue({ ok: true, envelope: validEnvelope });

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]test", true, "secret-token");

    expect(result.statusCode).toBe(200);

    delete process.env.AGORA_WEBHOOK_TOKEN;
    await httpServer.close();
  });

  it("should reject webhook with wrong token when AGORA_WEBHOOK_TOKEN is set", async () => {
    process.env.AGORA_WEBHOOK_TOKEN = "secret-token";
    const port = await httpServer.listen(0);

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]test", true, "wrong-token");

    expect(result.statusCode).toBe(401);
    expect(result.body).toMatchObject({ error: "Invalid or missing Authorization header" });

    delete process.env.AGORA_WEBHOOK_TOKEN;
    await httpServer.close();
  });

  it("should reject webhook with missing header when AGORA_WEBHOOK_TOKEN is set", async () => {
    process.env.AGORA_WEBHOOK_TOKEN = "secret-token";
    const port = await httpServer.listen(0);

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]test", false);

    expect(result.statusCode).toBe(401);
    expect(result.body).toMatchObject({ error: "Invalid or missing Authorization header" });

    delete process.env.AGORA_WEBHOOK_TOKEN;
    await httpServer.close();
  });

  it("should handle multiple messages in order", async () => {
    const port = await httpServer.listen(0);

    const agora = await import("@rookdaemon/agora");
    const testPeerPublicKey = "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const testPeerPrivateKey = "302e020100300506032b65700422044444444444444444444444444444444444444444444444444444444444444444444444";

    // Mock decodeInbound to return different properly signed envelopes
    let callCount = 0;
    jest.spyOn(agoraService, "decodeInbound").mockImplementation(async () => {
      callCount++;
      const envelope = agora.createEnvelope(
        "announce",
        testPeerPublicKey,
        testPeerPrivateKey,
        { data: `message ${callCount}` },
        1708000000000 + callCount
      );
      return {
        ok: true,
        envelope,
      };
    });

    // Send two messages
    await sendWebhookRequest(port, "[AGORA_ENVELOPE]msg1");
    clock.setNow(new Date("2026-02-15T12:01:00Z"));
    await sendWebhookRequest(port, "[AGORA_ENVELOPE]msg2");

    expect(injectedMessages).toHaveLength(2);
    expect(injectedMessages[0]).toContain("announce");
    expect(injectedMessages[1]).toContain("announce");

    // Verify both in CONVERSATION.md
    const conversationPath = config.getFilePath(SubstrateFileType.CONVERSATION);
    const conversationContent = await fs.readFile(conversationPath);
    expect(conversationContent).toContain("message 1");
    expect(conversationContent).toContain("message 2");
    expect(conversationContent).toContain("**data**:");

    await httpServer.close();
  });

  it("should reject webhook with invalid signature", async () => {
    const port = await httpServer.listen(0);

    // Create an envelope with an invalid signature (tampered)
    const invalidEnvelope: Envelope = {
      id: "fake-id",
      type: "request",
      sender: "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      timestamp: 1708000000000,
      payload: { question: "Malicious payload" },
      signature: "invalid-signature-xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx",
    };

    // Mock decodeInbound to return envelope with invalid signature
    jest.spyOn(agoraService, "decodeInbound").mockResolvedValue({
      ok: true,
      envelope: invalidEnvelope,
    });

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]tampered");

    // Should reject with 400 Bad Request
    expect(result.statusCode).toBe(400);
    expect(result.body.error).toContain("Invalid envelope signature");

    // Message should NOT be injected
    expect(injectedMessages).toHaveLength(0);

    await httpServer.close();
  });

  it("should reject webhook with missing signature", async () => {
    const port = await httpServer.listen(0);

    // Create an envelope with no signature
    const envelopeNoSignature = {
      id: "no-sig-id",
      type: "request",
      sender: "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc",
      timestamp: 1708000000000,
      payload: { question: "Unsigned message" },
      signature: "",
    } as Envelope;

    jest.spyOn(agoraService, "decodeInbound").mockResolvedValue({
      ok: true,
      envelope: envelopeNoSignature,
    });

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]unsigned");

    expect(result.statusCode).toBe(400);
    expect(result.body.error).toContain("Invalid envelope signature");

    // Message should NOT be injected
    expect(injectedMessages).toHaveLength(0);

    await httpServer.close();
  });

  it("should accept webhook with valid signature from known sender", async () => {
    const port = await httpServer.listen(0);

    // Create a properly signed envelope from a known peer
    const agora = await import("@rookdaemon/agora");
    const testPeerPublicKey = "302a300506032b6570032100cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc";
    const testPeerPrivateKey = "302e020100300506032b65700422044444444444444444444444444444444444444444444444444444444444444444444444";

    const validEnvelope = agora.createEnvelope(
      "announce",
      testPeerPublicKey,
      testPeerPrivateKey,
      { announcement: "I am a legitimate peer" },
      1708000000000
    );

    jest.spyOn(agoraService, "decodeInbound").mockResolvedValue({
      ok: true,
      envelope: validEnvelope,
    });

    const result = await sendWebhookRequest(port, "[AGORA_ENVELOPE]legitimate");

    expect(result.statusCode).toBe(200);
    expect(result.body).toMatchObject({ success: true, envelopeId: validEnvelope.id });

    // Message should be processed
    expect(injectedMessages).toHaveLength(1);
    expect(injectedMessages[0]).toContain("announce");
    expect(injectedMessages[0]).toContain("legitimate peer");

    await httpServer.close();
  });
});

// Helper function to send webhook request
async function sendWebhookRequest(
  port: number,
  message: string,
  withAuth = true,
  token = "test-token"
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
        ...(withAuth && { Authorization: `Bearer ${token}` }),
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
