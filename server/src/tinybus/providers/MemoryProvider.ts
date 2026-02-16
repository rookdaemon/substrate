import { Message } from "../core/Message";
import { Provider } from "../core/Provider";

/**
 * In-memory provider for testing
 *
 * Stores messages in memory and allows manual message injection
 */
export class MemoryProvider implements Provider {
  public readonly id: string;
  private ready = false;
  private started = false;
  private messageHandler?: (message: Message) => Promise<void>;
  private sentMessages: Message[] = [];
  private receivedMessages: Message[] = [];

  constructor(id: string) {
    this.id = id;
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
    this.sentMessages.push(message);
  }

  onMessage(handler: (message: Message) => Promise<void>): void {
    this.messageHandler = handler;
  }

  /**
   * Inject a message into the bus (simulate receiving from external source)
   */
  async injectMessage(message: Message): Promise<void> {
    if (!this.started) {
      throw new Error(`Provider ${this.id} not started`);
    }
    if (!this.messageHandler) {
      throw new Error(`No message handler registered for ${this.id}`);
    }

    this.receivedMessages.push(message);
    await this.messageHandler(message);
  }

  /**
   * Get all messages sent through this provider
   */
  getSentMessages(): Message[] {
    return [...this.sentMessages];
  }

  /**
   * Get all messages received by this provider
   */
  getReceivedMessages(): Message[] {
    return [...this.receivedMessages];
  }

  /**
   * Clear message history
   */
  clear(): void {
    this.sentMessages = [];
    this.receivedMessages = [];
  }
}
