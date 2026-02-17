import { Message } from "../core/Message";
import { Provider } from "../core/Provider";
import { IConversationManager } from "../../conversation/IConversationManager";
import { IClock } from "../../substrate/abstractions/IClock";
import { LoopState } from "../../loop/types";
import { AgentRole } from "../../agents/types";

/**
 * Provider that writes TinyBus messages to CONVERSATION.md when effectively paused
 * (explicitly paused OR rate-limited).
 * 
 * Messages are written with [UNPROCESSED] marker when effectively paused.
 * When running normally, this provider doesn't interfere with message routing.
 */
export class ConversationProvider implements Provider {
  public readonly id: string;
  private ready = false;
  private started = false;
  private messageHandler?: (message: Message) => Promise<void>;
  private conversationManager: IConversationManager;
  private clock: IClock;
  private getState: () => LoopState;
  private isRateLimited: () => boolean;

  constructor(
    id: string,
    conversationManager: IConversationManager,
    clock: IClock,
    getState: () => LoopState,
    isRateLimited: () => boolean
  ) {
    this.id = id;
    this.conversationManager = conversationManager;
    this.clock = clock;
    this.getState = getState;
    this.isRateLimited = isRateLimited;
  }

  async isReady(): Promise<boolean> {
    return this.ready;
  }

  async start(): Promise<void> {
    this.started = true;
    this.ready = true;
  }

  async stop(): Promise<void> {
    this.started = false;
    this.ready = false;
  }

  async send(message: Message): Promise<void> {
    if (!this.started) {
      throw new Error(`Provider ${this.id} not started`);
    }

    // Check if effectively paused (explicitly paused OR rate-limited)
    const state = this.getState();
    const isEffectivelyPaused = state === LoopState.PAUSED || state === LoopState.STOPPED || this.isRateLimited();

    if (isEffectivelyPaused) {
      try {
        // Write to CONVERSATION.md with [UNPROCESSED] marker
        const timestamp = this.clock.now().toISOString();
        const source = message.source || "unknown";
        const payloadStr = typeof message.payload === "string" 
          ? message.payload 
          : JSON.stringify(message.payload);
        
        const unprocessedMarker = "[UNPROCESSED] ";
        const conversationEntry = `[TINYBUS] [${timestamp}] ${unprocessedMarker}Type: ${message.type} Source: ${source} Payload: ${payloadStr}`;

        // Write to CONVERSATION.md (using SUBCONSCIOUS role as it handles message processing)
        await this.conversationManager.append(AgentRole.SUBCONSCIOUS, conversationEntry);
      } catch {
        // Don't throw - allow message to continue routing to other providers
        // Errors writing to CONVERSATION.md shouldn't break message routing
        // The error will be logged by TinyBus via the message.error event
      }
    }

    // Note: This provider doesn't prevent normal routing - messages still flow to other providers
    // via the TinyBus router. This provider just adds a side effect (writing to CONVERSATION.md)
    // when effectively paused.
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Get the message types this provider supports
   * Empty array means the provider accepts all message types
   */
  getMessageTypes(): string[] {
    return []; // Accept all message types
  }
}
