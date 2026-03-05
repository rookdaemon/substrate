import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import { TinyBus } from "../tinybus/core/TinyBus";
import { createMessage } from "../tinybus/core/Message";
import type { IAgoraService } from "./IAgoraService";

/**
 * Interface for managing ignored Agora peers (MCP-facing).
 * Implemented by AgoraMessageHandler.
 */
export interface IgnoredPeersManager {
  ignorePeer(publicKey: string): boolean;
  unignorePeer(publicKey: string): boolean;
  listIgnoredPeers(): string[];
}

export interface AgoraToolsOptions {
  tinyBus: TinyBus;
  agoraService: IAgoraService;
  ignoredPeersManager?: IgnoredPeersManager | null;
}

/**
 * Register all Agora-specific MCP tools on an existing McpServer.
 *
 * Extracted from TinyBusMcpServer so all Agora logic lives in agora/.
 */
export function registerAgoraTools(server: McpServer, options: AgoraToolsOptions): void {
  const { tinyBus, agoraService, ignoredPeersManager } = options;

  // -------------------------------------------------------------------------
  // send_agora_message
  // -------------------------------------------------------------------------
  server.tool(
    "send_agora_message",
    "Send a message to an Agora peer. Use this for all Agora communication instead of the generic send_message tool.",
    {
      to: z.union([z.string(), z.array(z.string())]).optional().describe(
        "Recipient(s) — a peer reference or array of peer references (configured name, full public key, or compact short form such as ...abcd1234)."
      ),
      targetPubkey: z.string().optional().describe(
        "Recipient public key (or compact short form) for relay-only replies to unknown senders. Requires inReplyTo."
      ),
      text: z.string().describe("Message text to send."),
      inReplyTo: z.string().optional().describe(
        "Envelope ID of the message being replied to. Always include when responding to a specific message."
      ),
    },
    async ({ to, targetPubkey, text, inReplyTo }) => {
      try {
        const agoraPayload: Record<string, unknown> = {
          type: "publish",
          payload: { text },
        };
        if (to) agoraPayload.to = Array.isArray(to) ? to : [to];
        if (targetPubkey) agoraPayload.targetPubkey = targetPubkey;
        if (inReplyTo) agoraPayload.inReplyTo = inReplyTo;

        const message = createMessage({
          type: "agora.send",
          payload: agoraPayload,
        });

        await tinyBus.publish(message);

        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({ success: true, messageId: message.id }),
            },
          ],
        };
      } catch (error) {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: false,
                error: error instanceof Error ? error.message : String(error),
              }),
            },
          ],
        };
      }
    }
  );

  // -------------------------------------------------------------------------
  // list_peers
  // -------------------------------------------------------------------------
  server.tool(
    "list_peers",
    "List all configured Agora peers with full public keys. Names are convenience labels only.",
    {},
    async () => {
      const peers = agoraService
        .getPeers()
        .map((peerRef: string) => {
          const peerConfig = agoraService.getPeerConfig(peerRef);
          if (!peerConfig) {
            return null;
          }
          return {
            name: peerConfig.name,
            publicKey: peerConfig.publicKey,
          };
        })
        .filter((peer: { name?: string; publicKey: string } | null): peer is { name?: string; publicKey: string } => peer !== null);

      return {
        content: [
          {
            type: "text",
            text: JSON.stringify({ peers }),
          },
        ],
      };
    }
  );

  // -------------------------------------------------------------------------
  // ignore_peer / unignore_peer / list_ignored_peers
  // -------------------------------------------------------------------------
  if (ignoredPeersManager) {
    server.tool(
      "ignore_peer",
      "Ignore a peer public key so inbound Agora messages from it are dropped",
      {
        publicKey: z.string().min(1).describe("Peer public key to ignore"),
      },
      async ({ publicKey }) => {
        const added = ignoredPeersManager.ignorePeer(publicKey);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                ignored: publicKey,
                added,
                ignoredPeers: ignoredPeersManager.listIgnoredPeers(),
              }),
            },
          ],
        };
      }
    );

    server.tool(
      "unignore_peer",
      "Remove a peer public key from the ignored Agora blocklist",
      {
        publicKey: z.string().min(1).describe("Peer public key to unignore"),
      },
      async ({ publicKey }) => {
        const removed = ignoredPeersManager.unignorePeer(publicKey);
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                success: true,
                unignored: publicKey,
                removed,
                ignoredPeers: ignoredPeersManager.listIgnoredPeers(),
              }),
            },
          ],
        };
      }
    );

    server.tool(
      "list_ignored_peers",
      "List peer public keys currently ignored for inbound Agora messages",
      {},
      async () => {
        return {
          content: [
            {
              type: "text",
              text: JSON.stringify({
                ignoredPeers: ignoredPeersManager.listIgnoredPeers(),
              }),
            },
          ],
        };
      }
    );
  }
}
