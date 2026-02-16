import { Message } from "./Message";

/**
 * Provider abstraction for TinyBus
 *
 * Providers are transport adapters that:
 * - Push inbound messages via onMessage callback
 * - Receive routed messages via send()
 * - Manage their own lifecycle (start/stop)
 * - Report readiness status
 */
export interface Provider {
  /** Unique provider identifier */
  id: string;

  /**
   * Check if provider is ready to send/receive messages
   */
  isReady(): Promise<boolean>;

  /**
   * Start the provider (connect, initialize resources)
   */
  start(): Promise<void>;

  /**
   * Stop the provider (disconnect, cleanup resources)
   */
  stop(): Promise<void>;

  /**
   * Send a message through this provider
   */
  send(message: Message): Promise<void>;

  /**
   * Register handler for inbound messages
   */
  onMessage(handler: (message: Message) => Promise<void>): void;

  /**
   * Get the message types this provider supports/processes
   * Returns an array of message type strings (e.g., ["agent.command.exec", "system.health.ping"])
   * Empty array means the provider accepts all message types
   */
  getMessageTypes(): string[];
}
