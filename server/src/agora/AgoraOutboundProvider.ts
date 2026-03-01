import { Message } from "../tinybus/core/Message";
import { Provider } from "../tinybus/core/Provider";
import { IAgoraService } from "./IAgoraService";
import type { ILogger } from "../logging";

/**
 * AgoraOutboundProvider - Handles outbound Agora messages via TinyBus
 *
 * Implements TinyBus Provider interface but lives in agora/ module
 * to maintain separation of concerns (all Agora code in one place).
 *
 * Expected message format:
 * - type: "agora.send"
 * - payload: { peerName?: string; type: string; payload: unknown; inReplyTo?: string }
 *
 * Broadcast: omit peerName or set to "all" to send to every configured peer.
 * Partial failures in broadcast mode are logged but don't throw unless ALL sends fail.
 */
export class AgoraOutboundProvider implements Provider {
  public readonly id = "agora";
  private ready = false;
  private started = false;

  constructor(
    private readonly agoraService: IAgoraService | null,
    private readonly logger?: ILogger,
  ) {}

  async isReady(): Promise<boolean> {
    return this.ready && this.agoraService !== null;
  }

  async start(): Promise<void> {
    this.started = true;
    // Only mark ready if Agora service is configured
    this.ready = this.agoraService !== null;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ready = false;
    // Disconnect relay if connected
    if (this.agoraService?.isRelayConnected()) {
      await this.agoraService.disconnectRelay();
    }
  }

  /**
   * Send outbound messages from TinyBus to Agora peers
   */
  async send(message: Message): Promise<void> {
    if (!this.started) {
      throw new Error(`Provider ${this.id} not started`);
    }

    if (!this.agoraService) {
      throw new Error("Agora service not configured");
    }

    // Only handle agora.send messages
    if (message.type !== "agora.send") {
      return;
    }

    const payload = message.payload as {
      peerName?: string;
      type: string;
      payload: unknown;
      inReplyTo?: string;
    };

    if (!payload.type) {
      throw new Error("Invalid agora.send payload: missing type");
    }

    // Broadcast: if peerName is omitted or "all", send to every configured peer
    const isBroadcast = !payload.peerName || payload.peerName === "all";
    const targets = isBroadcast
      ? this.agoraService.getPeers()
      : [payload.peerName];

    if (isBroadcast) {
      this.logger?.debug(
        `[AGORA-OUT] Broadcasting: type=${payload.type} to ${targets.length} peers` +
        (payload.inReplyTo ? ` inReplyTo=${payload.inReplyTo}` : "")
      );
    } else {
      this.logger?.debug(
        `[AGORA-OUT] Sending: peerName=${payload.peerName} type=${payload.type}` +
        (payload.inReplyTo ? ` inReplyTo=${payload.inReplyTo}` : "")
      );
    }

    const errors: string[] = [];
    for (const target of targets) {
      const result = await this.agoraService.sendMessage({
        peerName: target,
        type: payload.type,
        payload: payload.payload,
        inReplyTo: payload.inReplyTo,
      });

      if (!result.ok) {
        const errMsg = `Failed to send to ${target}: ${result.error ?? "unknown error"} (status=${result.status})`;
        this.logger?.debug(`[AGORA-OUT] ${errMsg}`);
        errors.push(errMsg);
      } else {
        this.logger?.debug(`[AGORA-OUT] Sent successfully: peerName=${target} status=${result.status}`);
      }
    }

    if (errors.length === targets.length && targets.length > 0) {
      throw new Error(`All sends failed: ${errors.join("; ")}`);
    }
  }

  onMessage(_handler: (message: Message) => Promise<void>): void {
    // Not used for outbound provider
  }

  /**
   * Get message types this provider handles
   */
  getMessageTypes(): string[] {
    return ["agora.send"];
  }
}
