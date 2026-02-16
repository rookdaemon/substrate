import { Message } from "./Message";
import { Provider } from "./Provider";
import { Router, DefaultRouter } from "./Router";

/**
 * TinyBus event types
 */
export type TinyBusEvent =
  | "tinybus.started"
  | "tinybus.stopped"
  | "message.inbound"
  | "message.outbound"
  | "message.routed"
  | "message.error"
  | "message.dropped";

/**
 * Event listener function
 */
export type EventListener = (data: unknown) => void;

/**
 * TinyBus Core
 *
 * Lightweight message routing subsystem that:
 * - Routes structured messages between providers
 * - Supports bidirectional flow
 * - Exposes minimal provider abstraction
 * - Is fully async and promise-driven
 */
export class TinyBus {
  private providers: Map<string, Provider> = new Map();
  private router: Router;
  private started = false;
  private eventListeners: Map<TinyBusEvent, Set<EventListener>> = new Map();

  constructor(router?: Router) {
    this.router = router ?? new DefaultRouter();
  }

  /**
   * Register a provider
   */
  registerProvider(provider: Provider): void {
    if (this.providers.has(provider.id)) {
      throw new Error(`Provider ${provider.id} already registered`);
    }

    this.providers.set(provider.id, provider);

    // Setup inbound message handler
    provider.onMessage(async (message: Message) => {
      await this.handleInboundMessage(message);
    });
  }

  /**
   * Start TinyBus and all providers
   */
  async start(): Promise<void> {
    if (this.started) {
      return;
    }

    // Start all providers
    const startPromises = Array.from(this.providers.values()).map((p) =>
      p.start()
    );
    await Promise.all(startPromises);

    // Wait for all providers to be ready
    const readyPromises = Array.from(this.providers.values()).map((p) =>
      p.isReady()
    );
    const readyStatuses = await Promise.all(readyPromises);

    if (readyStatuses.some((ready) => !ready)) {
      throw new Error("Not all providers are ready");
    }

    this.started = true;
    this.emit("tinybus.started", {});
  }

  /**
   * Stop TinyBus and all providers
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.started = false;

    // Stop all providers
    const stopPromises = Array.from(this.providers.values()).map((p) =>
      p.stop()
    );
    await Promise.all(stopPromises);

    this.emit("tinybus.stopped", {});
  }

  /**
   * Publish a message to TinyBus
   */
  async publish(message: Message): Promise<void> {
    if (!this.started) {
      throw new Error("TinyBus not started");
    }

    this.emit("message.outbound", { message });

    // Route message to target providers
    const providers = Array.from(this.providers.values());
    const targets = this.router.route(message, providers);

    if (targets.length === 0) {
      this.emit("message.dropped", { message, reason: "No target providers" });
      return;
    }

    // Send to all target providers
    const sendPromises = targets.map(async (provider) => {
      try {
        await provider.send(message);
        this.emit("message.routed", { message, provider: provider.id });
      } catch (error) {
        this.emit("message.error", {
          message,
          provider: provider.id,
          error:
            error instanceof Error ? error.message : "Unknown error",
        });
      }
    });

    await Promise.all(sendPromises);
  }

  /**
   * Handle inbound message from a provider
   */
  private async handleInboundMessage(message: Message): Promise<void> {
    this.emit("message.inbound", { message });

    try {
      await this.publish(message);
    } catch (error) {
      this.emit("message.error", {
        message,
        error:
          error instanceof Error ? error.message : "Unknown error",
      });
    }
  }

  /**
   * Register event listener
   */
  on(event: TinyBusEvent, listener: EventListener): void {
    if (!this.eventListeners.has(event)) {
      this.eventListeners.set(event, new Set());
    }
    this.eventListeners.get(event)!.add(listener);
  }

  /**
   * Remove event listener
   */
  off(event: TinyBusEvent, listener: EventListener): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      listeners.delete(listener);
    }
  }

  /**
   * Emit event to listeners (non-blocking)
   */
  private emit(event: TinyBusEvent, data: unknown): void {
    const listeners = this.eventListeners.get(event);
    if (listeners) {
      // Emit to all listeners asynchronously, but don't await
      listeners.forEach((listener) => {
        try {
          listener(data);
        } catch {
          // Silently ignore listener errors
        }
      });
    }
  }

  /**
   * Get all registered providers (for testing)
   */
  getProviders(): Provider[] {
    return Array.from(this.providers.values());
  }

  /**
   * Check if TinyBus is started
   */
  isStarted(): boolean {
    return this.started;
  }
}
