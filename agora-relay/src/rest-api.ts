/**
 * rest-api.ts — Express router implementing the Agora relay REST API.
 *
 * Endpoints:
 *   POST   /v1/register   — Register agent, obtain JWT session token
 *   POST   /v1/send       — Send message to a peer (requires auth)
 *   GET    /v1/peers      — List online peers (requires auth)
 *   GET    /v1/messages   — Poll for new inbound messages (requires auth)
 *   DELETE /v1/disconnect — Invalidate token and disconnect (requires auth)
 */

import { Router } from "express";
import type { Request, Response } from "express";
import {
  createToken,
  revokeToken,
  requireAuth,
  type AuthenticatedRequest,
} from "./jwt-auth.js";
import { MessageBuffer, type BufferedMessage } from "./message-buffer.js";

/**
 * A session for a REST-connected agent.
 * privateKey is held only in memory and never logged or persisted.
 */
export interface RestSession {
  publicKey: string;
  privateKey: string;
  name?: string;
  metadata?: { version?: string; capabilities?: string[] };
  registeredAt: number;
  /** Token expiry timestamp (ms). Used to clean up expired sessions. */
  expiresAt: number;
  token: string;
}

/**
 * Remove sessions whose JWT has expired.
 * Called on each registration to prevent unbounded memory growth.
 * The privateKey is held only for the lifetime of a valid session.
 */
function pruneExpiredSessions(
  sessions: Map<string, RestSession>,
  buffer: MessageBuffer
): void {
  const now = Date.now();
  for (const [publicKey, session] of sessions) {
    if (session.expiresAt <= now) {
      sessions.delete(publicKey);
      buffer.delete(publicKey);
    }
  }
}

/**
 * Minimal interface for the relay server that the REST API depends on.
 * Decoupled from the concrete RelayServer class for testability.
 */
export interface RelayInterface {
  getAgents(): Map<
    string,
    {
      publicKey: string;
      name?: string;
      lastSeen: number;
      metadata?: { version?: string; capabilities?: string[] };
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      socket: any;
    }
  >;
  on(
    event: "message-relayed",
    handler: (from: string, to: string, envelope: unknown) => void
  ): void;
}

/**
 * Envelope creation function interface (matches @rookdaemon/agora createEnvelope).
 */
export type CreateEnvelopeFn = (
  type: string,
  sender: string,
  privateKey: string,
  payload: unknown,
  timestamp?: number,
  inReplyTo?: string
) => {
  id: string;
  type: string;
  sender: string;
  timestamp: number;
  payload: unknown;
  signature: string;
  inReplyTo?: string;
};

/**
 * Envelope verification function interface.
 */
export type VerifyEnvelopeFn = (envelope: unknown) => {
  valid: boolean;
  reason?: string;
};

/**
 * Create the REST API router.
 *
 * @param relay      - Relay server instance for routing messages
 * @param buffer     - Shared message buffer for HTTP polling
 * @param sessions   - Shared session registry (publicKey → RestSession)
 * @param createEnv  - Envelope creation function (injectable for testing)
 * @param verifyEnv  - Envelope verification function (injectable for testing)
 */
export function createRestRouter(
  relay: RelayInterface,
  buffer: MessageBuffer,
  sessions: Map<string, RestSession>,
  createEnv: CreateEnvelopeFn,
  verifyEnv: VerifyEnvelopeFn
): Router {
  const router = Router();

  // Wire relay message-relayed event → buffer for REST polling clients
  relay.on("message-relayed", (from, to, envelope) => {
    if (!sessions.has(to)) {
      // Recipient is not a REST client — nothing to buffer
      return;
    }
    const agentMap = relay.getAgents();
    const senderAgent = agentMap.get(from);
    const env = envelope as {
      id: string;
      type: string;
      payload: unknown;
      timestamp: number;
      inReplyTo?: string;
    };
    const msg: BufferedMessage = {
      id: env.id,
      from,
      fromName: senderAgent?.name,
      type: env.type,
      payload: env.payload,
      timestamp: env.timestamp,
      inReplyTo: env.inReplyTo,
    };
    buffer.add(to, msg);
  });

  // ---------------------------------------------------------------------------
  // POST /v1/register
  // ---------------------------------------------------------------------------
  router.post("/v1/register", async (req: Request, res: Response) => {
    const { publicKey, privateKey, name, metadata } = req.body as {
      publicKey?: string;
      privateKey?: string;
      name?: string;
      metadata?: { version?: string; capabilities?: string[] };
    };

    if (!publicKey || typeof publicKey !== "string") {
      res.status(400).json({ error: "publicKey is required" });
      return;
    }
    if (!privateKey || typeof privateKey !== "string") {
      res.status(400).json({ error: "privateKey is required" });
      return;
    }

    // Verify that the agent actually owns this key pair by signing a test
    // envelope and immediately discarding the privateKey from this scope.
    const testEnvelope = createEnv(
      "announce",
      publicKey,
      privateKey,
      { challenge: "register" },
      Date.now()
    );
    const verification = verifyEnv(testEnvelope);
    if (!verification.valid) {
      res
        .status(400)
        .json({ error: "Key pair verification failed: " + verification.reason });
      return;
    }

    // Create JWT token
    const { token, expiresAt } = createToken({ publicKey, name });

    // Prune stale sessions before adding the new one
    pruneExpiredSessions(sessions, buffer);

    // Store session (privateKey kept in memory for envelope signing)
    const session: RestSession = {
      publicKey,
      privateKey, // NEVER logged, NEVER persisted beyond process memory
      name,
      metadata,
      registeredAt: Date.now(),
      expiresAt,
      token,
    };
    sessions.set(publicKey, session);

    // Build peer list from relay WS agents + other REST sessions
    const wsAgents = relay.getAgents();
    const peers: Array<{
      publicKey: string;
      name?: string;
      lastSeen: number;
    }> = [];
    for (const agent of wsAgents.values()) {
      if (agent.publicKey !== publicKey) {
        peers.push({
          publicKey: agent.publicKey,
          name: agent.name,
          lastSeen: agent.lastSeen,
        });
      }
    }
    for (const s of sessions.values()) {
      if (
        s.publicKey !== publicKey &&
        !wsAgents.has(s.publicKey) // avoid duplicates
      ) {
        peers.push({
          publicKey: s.publicKey,
          name: s.name,
          lastSeen: s.registeredAt,
        });
      }
    }

    res.json({ token, expiresAt, peers });
  });

  // ---------------------------------------------------------------------------
  // POST /v1/send
  // ---------------------------------------------------------------------------
  router.post(
    "/v1/send",
    requireAuth,
    async (req: AuthenticatedRequest, res: Response) => {
      const { to, type, payload, inReplyTo } = req.body as {
        to?: string;
        type?: string;
        payload?: unknown;
        inReplyTo?: string;
      };

      if (!to || typeof to !== "string") {
        res.status(400).json({ error: "to is required" });
        return;
      }
      if (!type || typeof type !== "string") {
        res.status(400).json({ error: "type is required" });
        return;
      }
      if (payload === undefined) {
        res.status(400).json({ error: "payload is required" });
        return;
      }

      const senderPublicKey = req.agent!.publicKey;
      const session = sessions.get(senderPublicKey);
      if (!session) {
        res.status(401).json({ error: "Session not found — please re-register" });
        return;
      }

      // Create and sign envelope on behalf of the authenticated agent
      const envelope = createEnv(
        type,
        senderPublicKey,
        session.privateKey,
        payload,
        Date.now(),
        inReplyTo
      );

      // Route to WebSocket recipient if present in relay
      const wsAgents = relay.getAgents();
      const wsRecipient = wsAgents.get(to);
      if (wsRecipient && wsRecipient.socket) {
        const ws = wsRecipient.socket;
        const OPEN = 1; // WebSocket.OPEN constant
        if (ws.readyState !== OPEN) {
          res.status(503).json({ error: "Recipient connection is not open" });
          return;
        }
        try {
          const relayMsg = JSON.stringify({
            type: "message",
            from: senderPublicKey,
            name: session.name,
            envelope,
          });
          ws.send(relayMsg);
          res.json({ ok: true, envelopeId: envelope.id });
          return;
        } catch (err) {
          res.status(500).json({
            error:
              "Failed to deliver message: " +
              (err instanceof Error ? err.message : String(err)),
          });
          return;
        }
      }

      // Route to REST recipient if present in sessions
      const restRecipient = sessions.get(to);
      if (restRecipient) {
        const senderAgent = wsAgents.get(senderPublicKey);
        const msg: BufferedMessage = {
          id: envelope.id,
          from: senderPublicKey,
          fromName: session.name ?? senderAgent?.name,
          type: envelope.type,
          payload: envelope.payload,
          timestamp: envelope.timestamp,
          inReplyTo: envelope.inReplyTo,
        };
        buffer.add(to, msg);
        res.json({ ok: true, envelopeId: envelope.id });
        return;
      }

      res.status(404).json({ error: "Recipient not connected" });
    }
  );

  // ---------------------------------------------------------------------------
  // GET /v1/peers
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/peers",
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const callerPublicKey = req.agent!.publicKey;
      const wsAgents = relay.getAgents();
      const peerList: Array<{
        publicKey: string;
        name?: string;
        lastSeen: number;
        metadata?: { version?: string; capabilities?: string[] };
      }> = [];

      for (const agent of wsAgents.values()) {
        if (agent.publicKey !== callerPublicKey) {
          peerList.push({
            publicKey: agent.publicKey,
            name: agent.name,
            lastSeen: agent.lastSeen,
            metadata: agent.metadata,
          });
        }
      }

      for (const s of sessions.values()) {
        if (
          s.publicKey !== callerPublicKey &&
          !wsAgents.has(s.publicKey) // avoid duplicates
        ) {
          peerList.push({
            publicKey: s.publicKey,
            name: s.name,
            lastSeen: s.registeredAt,
            metadata: s.metadata,
          });
        }
      }

      res.json({ peers: peerList });
    }
  );

  // ---------------------------------------------------------------------------
  // GET /v1/messages
  // ---------------------------------------------------------------------------
  router.get(
    "/v1/messages",
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const publicKey = req.agent!.publicKey;
      const sinceRaw = req.query.since as string | undefined;
      const limitRaw = req.query.limit as string | undefined;

      const since = sinceRaw ? parseInt(sinceRaw, 10) : undefined;
      const limit = Math.min(
        limitRaw ? parseInt(limitRaw, 10) : 50,
        100
      );

      let messages = buffer.get(publicKey, since);

      const hasMore = messages.length > limit;
      if (hasMore) {
        messages = messages.slice(0, limit);
      }

      // Clear buffer when polling without `since` (full poll)
      if (since === undefined) {
        buffer.clear(publicKey);
      }

      res.json({ messages, hasMore });
    }
  );

  // ---------------------------------------------------------------------------
  // DELETE /v1/disconnect
  // ---------------------------------------------------------------------------
  router.delete(
    "/v1/disconnect",
    requireAuth,
    (req: AuthenticatedRequest, res: Response) => {
      const publicKey = req.agent!.publicKey;
      const authHeader = req.headers.authorization!;
      const token = authHeader.slice(7);

      // Revoke the JWT so it cannot be reused
      revokeToken(token);

      // Remove session and clean up buffers
      sessions.delete(publicKey);
      buffer.delete(publicKey);

      res.json({ ok: true });
    }
  );

  return router;
}
