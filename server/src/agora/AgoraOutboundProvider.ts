import { Message } from "../tinybus/core/Message";
import { Provider } from "../tinybus/core/Provider";
import { IAgoraService } from "./IAgoraService";

/**
 * AgoraOutboundProvider - Handles outbound Agora messages via TinyBus
 * 
 * Implements TinyBus Provider interface but lives in agora/ module
 * to maintain separation of concerns (all Agora code in one place).
 * 
 * Expected message format:
 * - type: "agora.send"
 * - payload: { peerName: string; type: string; payload: unknown; inReplyTo?: string }
 */
export class AgoraOutboundProvider implements Provider {
  public readonly id = "agora";
  private ready = false;
  private started = false;

  constructor(private readonly agoraService: IAgoraService | null) {}

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
      peerName: string;
      type: string;
      payload: unknown;
      inReplyTo?: string;
    };

    if (!payload.peerName || !payload.type) {
      throw new Error("Invalid agora.send payload: missing peerName or type");
    }

    const result = await this.agoraService.sendMessage({
      peerName: payload.peerName,
      type: payload.type,
      payload: payload.payload,
      inReplyTo: payload.inReplyTo,
    });

    if (!result.ok) {
      throw new Error(`Failed to send Agora message: ${result.error ?? "unknown error"}`);
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
