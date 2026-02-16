import { Message, createMessage } from "../core/Message";
import { Provider } from "../core/Provider";
import { AppendOnlyWriter } from "../../substrate/io/AppendOnlyWriter";
import { SubstrateFileType } from "../../substrate/types";
import { AgoraInboxManager } from "../../agora/AgoraInboxManager";
import { ILoopEventSink } from "../../loop/ILoopEventSink";
import { IClock } from "../../substrate/abstractions/IClock";
import { shortKey } from "../../agora/utils";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

// Type for AgoraService from @rookdaemon/agora
interface AgoraServiceType {
  sendMessage(options: { peerName: string; type: string; payload: unknown; inReplyTo?: string }): Promise<{ ok: boolean; status: number; error?: string }>;
  decodeInbound(message: string): Promise<{ ok: boolean; envelope?: Envelope; reason?: string }>;
  getPeers(): string[];
  getPeerConfig(name: string): { publicKey: string; url: string; token: string } | undefined;
  connectRelay(url: string): Promise<void>;
  disconnectRelay(): Promise<void>;
  setRelayMessageHandler(handler: (envelope: Envelope) => void): void;
  isRelayConnected(): boolean;
}

/**
 * AgoraProvider - Routes Agora peer-to-peer messages through TinyBus
 * 
 * Inbound flow: Webhook/Relay → processEnvelope() → TinyBus → SessionInjectionProvider
 * Outbound flow: TinyBus → send() → AgoraService.sendMessage()
 */
export class AgoraProvider implements Provider {
  public readonly id = "agora";
  private ready = false;
  private started = false;
  private messageHandler?: (message: Message) => Promise<void>;

  constructor(
    private readonly agoraService: AgoraServiceType | null,
    private readonly appendWriter: AppendOnlyWriter,
    private readonly agoraInboxManager: AgoraInboxManager,
    private readonly eventSink: ILoopEventSink | null,
    private readonly clock: IClock
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
   * 
   * Expected message format:
   * - type: "agora.send"
   * - payload: { peerName: string; type: string; payload: unknown; inReplyTo?: string }
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

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Process an inbound Agora envelope (called by webhook handler or relay)
   * 
   * Four-step pipeline:
   * 1. Log to PROGRESS.md
   * 2. Persist to AGORA_INBOX.md
   * 3. Emit WebSocket event
   * 4. Route through TinyBus → SessionInjectionProvider → Orchestrator
   */
  async processEnvelope(envelope: Envelope, source: "webhook" | "relay" = "webhook"): Promise<void> {
    const timestamp = this.clock.now().toISOString();
    const senderShort = shortKey(envelope.sender);

    // 1. Log to PROGRESS.md
    const sourceLabel = source === "relay" ? "AGORA-RELAY" : "AGORA";
    const payloadStr = JSON.stringify(envelope.payload);
    const truncatedPayload = payloadStr.length > 200
      ? payloadStr.substring(0, 200) + "..."
      : payloadStr;
    const logEntry = `[${sourceLabel}] Received ${envelope.type} from ${senderShort} — payload: ${truncatedPayload}`;
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
          source,
        },
      });
    }

    // 4. Route through TinyBus
    if (this.messageHandler) {
      const messageType = source === "relay" ? "agora.relay.message" : "agora.peer.message";
      const tinyBusMessage = createMessage({
        type: messageType,
        source: this.id,
        destination: "session-injection", // Route to orchestrator
        payload: {
          sender: envelope.sender,
          senderShort,
          envelopeId: envelope.id,
          messageType: envelope.type,
          payload: envelope.payload,
          timestamp,
        },
      });

      await this.messageHandler(tinyBusMessage);
    }
  }

  /**
   * Get message types this provider handles
   * - agora.peer.message: Direct webhook messages
   * - agora.relay.message: Relay client messages
   * - agora.send: Outbound messages to peers
   */
  getMessageTypes(): string[] {
    return ["agora.peer.message", "agora.relay.message", "agora.send"];
  }
}
