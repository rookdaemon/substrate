import { Message } from "../core/Message";
import { Provider } from "../core/Provider";

/**
 * Provider that injects TinyBus messages into the Claude Code session
 * via the orchestrator's injectMessage method.
 */
export class SessionInjectionProvider implements Provider {
  public readonly id: string;
  private ready = false;
  private started = false;
  private messageHandler?: (message: Message) => Promise<void>;
  private injectFn: (message: string) => void;

  constructor(id: string, injectFn: (message: string) => void) {
    this.id = id;
    this.injectFn = injectFn;
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

    // Convert TinyBus message to string format for injection
    // Format: JSON representation of the message
    const messageText = JSON.stringify({
      type: message.type,
      payload: message.payload,
      meta: message.meta,
      source: message.source,
      destination: message.destination,
      timestamp: message.timestamp,
    }, null, 2);

    // Inject into Claude Code session
    this.injectFn(messageText);
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
