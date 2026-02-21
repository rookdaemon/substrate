/**
 * rest-api.test.ts — Full endpoint test coverage for the Agora relay REST API.
 */

import express from "express";
import supertest from "supertest";
import jwt from "jsonwebtoken";
import { createRestRouter, type RelayInterface, type RestSession } from "../src/rest-api";
import { MessageBuffer } from "../src/message-buffer";

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

const TEST_JWT_SECRET = "test-secret-at-least-32-bytes-long!!";

function setJwtEnv() {
  process.env.AGORA_RELAY_JWT_SECRET = TEST_JWT_SECRET;
  process.env.AGORA_JWT_EXPIRY_SECONDS = "3600";
}

function clearJwtEnv() {
  delete process.env.AGORA_RELAY_JWT_SECRET;
  delete process.env.AGORA_JWT_EXPIRY_SECONDS;
}

/** Create a mock WebSocket-like object */
function mockSocket(open = true) {
  return {
    readyState: open ? 1 : 3, // 1 = OPEN, 3 = CLOSED
    sent: [] as string[],
    send(data: string) {
      this.sent.push(data);
    },
  };
}

/** Create a mock relay with controllable agent map */
function createMockRelay(
  agents: Map<string, { publicKey: string; name?: string; lastSeen: number; metadata?: { version?: string; capabilities?: string[] }; socket: ReturnType<typeof mockSocket> }> = new Map()
): RelayInterface & { _listeners: Array<(from: string, to: string, env: unknown) => void>; _emit(from: string, to: string, env: unknown): void } {
  const listeners: Array<(from: string, to: string, env: unknown) => void> = [];
  return {
    getAgents: () => agents as any, // eslint-disable-line @typescript-eslint/no-explicit-any
    on(_event: string, handler: (from: string, to: string, env: unknown) => void) {
      listeners.push(handler);
    },
    _listeners: listeners,
    _emit(from: string, to: string, env: unknown) {
      listeners.forEach(h => h(from, to, env));
    },
  };
}

/** Deterministic mock envelope factory */
let envelopeCounter = 0;
function mockCreateEnvelope(
  type: string,
  sender: string,
  _privateKey: string,
  payload: unknown,
  timestamp?: number,
  inReplyTo?: string
) {
  return {
    id: `env-${++envelopeCounter}`,
    type,
    sender,
    timestamp: timestamp ?? Date.now(),
    payload,
    signature: `sig-${sender.slice(-4)}`,
    ...(inReplyTo && { inReplyTo }),
  };
}

function mockVerifyEnvelope(env: unknown) {
  const e = env as { signature?: string };
  if (e.signature?.startsWith("sig-")) return { valid: true };
  return { valid: false, reason: "bad signature" };
}

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function buildApp(
  relay = createMockRelay(),
  buffer = new MessageBuffer(),
  sessions = new Map<string, RestSession>()
) {
  const app = express();
  app.use(express.json());
  app.use(
    createRestRouter(relay, buffer, sessions, mockCreateEnvelope, mockVerifyEnvelope)
  );
  return { app, relay, buffer, sessions };
}

const ALICE = {
  publicKey: "alice-pub-key-0000000000000000",
  privateKey: "alice-priv-key-000000000000000",
  name: "alice",
};
const BOB = {
  publicKey: "bob-pub-key-00000000000000000",
  privateKey: "bob-priv-key-0000000000000000",
  name: "bob",
};

// ---------------------------------------------------------------------------
// Register flow
// ---------------------------------------------------------------------------

describe("POST /v1/register", () => {
  beforeEach(setJwtEnv);
  afterEach(clearJwtEnv);

  it("returns token + expiresAt + peers on valid registration", async () => {
    const { app } = buildApp();
    const res = await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
      name: ALICE.name,
    });

    expect(res.status).toBe(200);
    expect(res.body.token).toBeDefined();
    expect(typeof res.body.expiresAt).toBe("number");
    expect(Array.isArray(res.body.peers)).toBe(true);
  });

  it("stores session in registry", async () => {
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(), new MessageBuffer(), sessions);
    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });

    expect(sessions.has(ALICE.publicKey)).toBe(true);
    // Private key must be stored (for envelope signing) but not returned to client
  });

  it("includes WS agents in peer list", async () => {
    const wsSocket = mockSocket();
    const agents = new Map([
      [BOB.publicKey, { publicKey: BOB.publicKey, name: BOB.name, lastSeen: 1000, socket: wsSocket }],
    ]);
    const { app } = buildApp(createMockRelay(agents));
    const res = await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });

    expect(res.body.peers).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ publicKey: BOB.publicKey, name: BOB.name }),
      ])
    );
  });

  it("returns 400 when publicKey is missing", async () => {
    const { app } = buildApp();
    const res = await supertest(app).post("/v1/register").send({
      privateKey: ALICE.privateKey,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/publicKey/);
  });

  it("returns 400 when privateKey is missing", async () => {
    const { app } = buildApp();
    const res = await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/privateKey/);
  });

  it("returns 400 when key pair verification fails", async () => {
    const badVerify = () => ({ valid: false, reason: "invalid key" });
    const sessions = new Map<string, RestSession>();
    const buffer = new MessageBuffer();
    const app = express();
    app.use(express.json());
    app.use(
      createRestRouter(createMockRelay(), buffer, sessions, mockCreateEnvelope, badVerify)
    );

    const res = await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: "bad-key",
    });
    expect(res.status).toBe(400);
    expect(res.body.error).toMatch(/verification failed/i);
  });
});

// ---------------------------------------------------------------------------
// Send flow
// ---------------------------------------------------------------------------

describe("POST /v1/send", () => {
  beforeEach(setJwtEnv);
  afterEach(clearJwtEnv);

  async function registerAndGetToken(app: ReturnType<typeof express>) {
    const res = await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
      name: ALICE.name,
    });
    return res.body.token as string;
  }

  it("returns 401 without auth header", async () => {
    const { app } = buildApp();
    const res = await supertest(app).post("/v1/send").send({
      to: BOB.publicKey,
      type: "publish",
      payload: { text: "hello" },
    });
    expect(res.status).toBe(401);
  });

  it("delivers message to WS recipient", async () => {
    const bobSocket = mockSocket();
    const agents = new Map([
      [BOB.publicKey, { publicKey: BOB.publicKey, name: BOB.name, lastSeen: Date.now(), socket: bobSocket }],
    ]);
    const { app } = buildApp(createMockRelay(agents));
    const token = await registerAndGetToken(app);

    const res = await supertest(app)
      .post("/v1/send")
      .set("Authorization", `Bearer ${token}`)
      .send({ to: BOB.publicKey, type: "publish", payload: { text: "hello" } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(res.body.envelopeId).toBeDefined();
    expect(bobSocket.sent).toHaveLength(1);
    const sent = JSON.parse(bobSocket.sent[0]);
    expect(sent.type).toBe("message");
    expect(sent.from).toBe(ALICE.publicKey);
  });

  it("buffers message for REST recipient", async () => {
    const buffer = new MessageBuffer();
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(), buffer, sessions);

    // Register Alice
    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
      name: ALICE.name,
    });
    // Register Bob
    await supertest(app).post("/v1/register").send({
      publicKey: BOB.publicKey,
      privateKey: BOB.privateKey,
      name: BOB.name,
    });

    const aliceToken = sessions.get(ALICE.publicKey)!.token;

    const res = await supertest(app)
      .post("/v1/send")
      .set("Authorization", `Bearer ${aliceToken}`)
      .send({ to: BOB.publicKey, type: "publish", payload: { text: "hi bob" } });

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);

    const msgs = buffer.get(BOB.publicKey);
    expect(msgs).toHaveLength(1);
    expect(msgs[0].payload).toEqual({ text: "hi bob" });
    expect(msgs[0].from).toBe(ALICE.publicKey);
  });

  it("returns 404 when recipient is not connected", async () => {
    const { app } = buildApp();
    const token = await registerAndGetToken(app);

    const res = await supertest(app)
      .post("/v1/send")
      .set("Authorization", `Bearer ${token}`)
      .send({ to: "unknown-peer", type: "publish", payload: { text: "hi" } });

    expect(res.status).toBe(404);
    expect(res.body.error).toMatch(/not connected/i);
  });

  it("returns 400 when required fields are missing", async () => {
    const { app } = buildApp();
    const token = await registerAndGetToken(app);

    const missing = [
      { type: "publish", payload: {} },               // missing to
      { to: BOB.publicKey, payload: {} },             // missing type
      { to: BOB.publicKey, type: "publish" },         // missing payload
    ];

    for (const body of missing) {
      const res = await supertest(app)
        .post("/v1/send")
        .set("Authorization", `Bearer ${token}`)
        .send(body);
      expect(res.status).toBe(400);
    }
  });

  it("returns 503 when WS recipient socket is closed", async () => {
    const closedSocket = mockSocket(false);
    const agents = new Map([
      [BOB.publicKey, { publicKey: BOB.publicKey, name: BOB.name, lastSeen: Date.now(), socket: closedSocket }],
    ]);
    const { app } = buildApp(createMockRelay(agents));
    const token = await registerAndGetToken(app);

    const res = await supertest(app)
      .post("/v1/send")
      .set("Authorization", `Bearer ${token}`)
      .send({ to: BOB.publicKey, type: "publish", payload: { text: "hi" } });

    expect(res.status).toBe(503);
  });
});

// ---------------------------------------------------------------------------
// Peers list
// ---------------------------------------------------------------------------

describe("GET /v1/peers", () => {
  beforeEach(setJwtEnv);
  afterEach(clearJwtEnv);

  it("returns 401 without auth", async () => {
    const { app } = buildApp();
    const res = await supertest(app).get("/v1/peers");
    expect(res.status).toBe(401);
  });

  it("lists WS agents and REST sessions (excluding caller)", async () => {
    const charlie = { publicKey: "charlie-pub-key-00000000000000", name: "charlie" };
    const wsAgents = new Map([
      [charlie.publicKey, { publicKey: charlie.publicKey, name: charlie.name, lastSeen: 2000, socket: mockSocket() }],
    ]);
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(wsAgents), new MessageBuffer(), sessions);

    // Register Alice
    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
      name: ALICE.name,
    });
    // Register Bob as REST
    await supertest(app).post("/v1/register").send({
      publicKey: BOB.publicKey,
      privateKey: BOB.privateKey,
      name: BOB.name,
    });

    const aliceToken = sessions.get(ALICE.publicKey)!.token;
    const res = await supertest(app)
      .get("/v1/peers")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(200);
    const publicKeys = res.body.peers.map((p: { publicKey: string }) => p.publicKey);
    expect(publicKeys).toContain(charlie.publicKey); // WS peer
    expect(publicKeys).toContain(BOB.publicKey);     // REST peer
    expect(publicKeys).not.toContain(ALICE.publicKey); // Caller excluded
  });

  it("does not duplicate agents that are in both relay and sessions", async () => {
    // Edge case: same publicKey in both WS agents and sessions
    const wsAgents = new Map([
      [BOB.publicKey, { publicKey: BOB.publicKey, name: BOB.name, lastSeen: 1000, socket: mockSocket() }],
    ]);
    const sessions = new Map<string, RestSession>([
      [BOB.publicKey, { publicKey: BOB.publicKey, privateKey: BOB.privateKey, name: BOB.name, registeredAt: 1000, expiresAt: Date.now() + 3600000, token: "tok" }],
    ]);
    const { app } = buildApp(createMockRelay(wsAgents), new MessageBuffer(), sessions);

    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });
    const aliceToken = sessions.get(ALICE.publicKey)!.token;

    const res = await supertest(app)
      .get("/v1/peers")
      .set("Authorization", `Bearer ${aliceToken}`);

    const bobPeers = res.body.peers.filter((p: { publicKey: string }) => p.publicKey === BOB.publicKey);
    expect(bobPeers).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// Message polling
// ---------------------------------------------------------------------------

describe("GET /v1/messages", () => {
  beforeEach(setJwtEnv);
  afterEach(clearJwtEnv);

  it("returns 401 without auth", async () => {
    const { app } = buildApp();
    const res = await supertest(app).get("/v1/messages");
    expect(res.status).toBe(401);
  });

  it("returns buffered messages", async () => {
    const buffer = new MessageBuffer();
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(), buffer, sessions);

    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });

    buffer.add(ALICE.publicKey, {
      id: "msg-1",
      from: BOB.publicKey,
      fromName: "bob",
      type: "publish",
      payload: { text: "hello" },
      timestamp: 1000,
    });
    buffer.add(ALICE.publicKey, {
      id: "msg-2",
      from: BOB.publicKey,
      fromName: "bob",
      type: "publish",
      payload: { text: "world" },
      timestamp: 2000,
    });

    const aliceToken = sessions.get(ALICE.publicKey)!.token;
    const res = await supertest(app)
      .get("/v1/messages")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2);
    expect(res.body.hasMore).toBe(false);
    // Buffer should be cleared after full poll (no `since`)
    expect(buffer.get(ALICE.publicKey)).toHaveLength(0);
  });

  it("filters by `since` and does not clear buffer", async () => {
    const buffer = new MessageBuffer();
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(), buffer, sessions);

    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });

    buffer.add(ALICE.publicKey, { id: "m1", from: BOB.publicKey, type: "publish", payload: {}, timestamp: 1000 });
    buffer.add(ALICE.publicKey, { id: "m2", from: BOB.publicKey, type: "publish", payload: {}, timestamp: 2000 });
    buffer.add(ALICE.publicKey, { id: "m3", from: BOB.publicKey, type: "publish", payload: {}, timestamp: 3000 });

    const aliceToken = sessions.get(ALICE.publicKey)!.token;
    const res = await supertest(app)
      .get("/v1/messages?since=1500")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(200);
    expect(res.body.messages).toHaveLength(2); // m2 and m3
    expect(res.body.messages[0].id).toBe("m2");
    // Buffer NOT cleared when `since` is provided
    expect(buffer.get(ALICE.publicKey)).toHaveLength(3);
  });

  it("respects limit parameter", async () => {
    const buffer = new MessageBuffer();
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(), buffer, sessions);

    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });
    const aliceToken = sessions.get(ALICE.publicKey)!.token;

    for (let i = 0; i < 10; i++) {
      buffer.add(ALICE.publicKey, { id: `m${i}`, from: BOB.publicKey, type: "publish", payload: {}, timestamp: i * 100 });
    }

    const res = await supertest(app)
      .get("/v1/messages?limit=3")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.body.messages).toHaveLength(3);
    expect(res.body.hasMore).toBe(true);
  });

  it("buffers messages delivered via relay message-relayed event", async () => {
    const relay = createMockRelay();
    const buffer = new MessageBuffer();
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(relay, buffer, sessions);

    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });
    const aliceToken = sessions.get(ALICE.publicKey)!.token;

    // Simulate relay delivering a message to Alice (a REST client)
    const envelope = {
      id: "relay-msg-1",
      type: "publish",
      sender: BOB.publicKey,
      payload: { text: "from ws" },
      timestamp: Date.now(),
      signature: "sig-test",
    };
    relay._emit(BOB.publicKey, ALICE.publicKey, envelope);

    const res = await supertest(app)
      .get("/v1/messages")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.body.messages).toHaveLength(1);
    expect(res.body.messages[0].payload).toEqual({ text: "from ws" });
  });

  it("does NOT buffer relay messages for WS-only recipients", async () => {
    const wsAgents = new Map([
      [BOB.publicKey, { publicKey: BOB.publicKey, name: BOB.name, lastSeen: Date.now(), socket: mockSocket() }],
    ]);
    const relay = createMockRelay(wsAgents);
    const buffer = new MessageBuffer();
    const sessions = new Map<string, RestSession>();
    buildApp(relay, buffer, sessions);

    // Bob is a WS client (not in sessions) — his messages should NOT be buffered
    relay._emit(ALICE.publicKey, BOB.publicKey, {
      id: "ws-msg", type: "publish", sender: ALICE.publicKey, payload: {}, timestamp: 1, signature: "sig-test",
    });

    expect(buffer.get(BOB.publicKey)).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Disconnect
// ---------------------------------------------------------------------------

describe("DELETE /v1/disconnect", () => {
  beforeEach(setJwtEnv);
  afterEach(clearJwtEnv);

  it("returns 401 without auth", async () => {
    const { app } = buildApp();
    const res = await supertest(app).delete("/v1/disconnect");
    expect(res.status).toBe(401);
  });

  it("removes session and clears buffer", async () => {
    const buffer = new MessageBuffer();
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(), buffer, sessions);

    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });
    const aliceToken = sessions.get(ALICE.publicKey)!.token;

    buffer.add(ALICE.publicKey, { id: "m1", from: BOB.publicKey, type: "publish", payload: {}, timestamp: 1 });

    const res = await supertest(app)
      .delete("/v1/disconnect")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(200);
    expect(res.body.ok).toBe(true);
    expect(sessions.has(ALICE.publicKey)).toBe(false);
    expect(buffer.get(ALICE.publicKey)).toHaveLength(0);
  });

  it("revokes token so it cannot be used again", async () => {
    const sessions = new Map<string, RestSession>();
    const { app } = buildApp(createMockRelay(), new MessageBuffer(), sessions);

    await supertest(app).post("/v1/register").send({
      publicKey: ALICE.publicKey,
      privateKey: ALICE.privateKey,
    });
    const aliceToken = sessions.get(ALICE.publicKey)!.token;

    // Disconnect
    await supertest(app)
      .delete("/v1/disconnect")
      .set("Authorization", `Bearer ${aliceToken}`);

    // Attempt to use revoked token
    const res = await supertest(app)
      .get("/v1/peers")
      .set("Authorization", `Bearer ${aliceToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/revoked/i);
  });
});

// ---------------------------------------------------------------------------
// JWT expiry handling
// ---------------------------------------------------------------------------

describe("Token expiry", () => {
  afterEach(clearJwtEnv);

  it("returns 401 with expired token", async () => {
    process.env.AGORA_RELAY_JWT_SECRET = TEST_JWT_SECRET;

    const { app } = buildApp();

    // Sign a token that is already expired
    const expiredToken = jwt.sign(
      { publicKey: ALICE.publicKey, jti: "expired-jti" },
      TEST_JWT_SECRET,
      { expiresIn: -1 }
    );

    const res = await supertest(app)
      .get("/v1/peers")
      .set("Authorization", `Bearer ${expiredToken}`);

    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/expired/i);
  });

  it("returns 401 with invalid token", async () => {
    process.env.AGORA_RELAY_JWT_SECRET = TEST_JWT_SECRET;
    const { app } = buildApp();
    const res = await supertest(app)
      .get("/v1/peers")
      .set("Authorization", "Bearer not-a-valid-jwt");
    expect(res.status).toBe(401);
    expect(res.body.error).toMatch(/invalid token/i);
  });
});

// ---------------------------------------------------------------------------
// MessageBuffer unit tests
// ---------------------------------------------------------------------------

describe("MessageBuffer", () => {
  it("evicts oldest messages when full (max 100)", () => {
    const buf = new MessageBuffer();
    const key = "agent-1";
    for (let i = 0; i < 105; i++) {
      buf.add(key, { id: `m${i}`, from: "a", type: "t", payload: {}, timestamp: i });
    }
    const msgs = buf.get(key);
    expect(msgs).toHaveLength(100);
    expect(msgs[0].id).toBe("m5"); // First 5 evicted
    expect(msgs[99].id).toBe("m104");
  });

  it("filters by since (exclusive)", () => {
    const buf = new MessageBuffer();
    buf.add("k", { id: "a", from: "x", type: "t", payload: {}, timestamp: 100 });
    buf.add("k", { id: "b", from: "x", type: "t", payload: {}, timestamp: 200 });
    buf.add("k", { id: "c", from: "x", type: "t", payload: {}, timestamp: 300 });

    const result = buf.get("k", 100);
    expect(result).toHaveLength(2);
    expect(result[0].id).toBe("b");
  });

  it("clear empties the buffer", () => {
    const buf = new MessageBuffer();
    buf.add("k", { id: "a", from: "x", type: "t", payload: {}, timestamp: 1 });
    buf.clear("k");
    expect(buf.get("k")).toHaveLength(0);
  });

  it("delete removes key entirely", () => {
    const buf = new MessageBuffer();
    buf.add("k", { id: "a", from: "x", type: "t", payload: {}, timestamp: 1 });
    buf.delete("k");
    expect(buf.get("k")).toHaveLength(0);
  });
});
