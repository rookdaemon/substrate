import { Message } from "./Message";
import { Provider } from "./Provider";
import { Router, DefaultRouter } from "./Router";
import type { ILogger } from "../../logging";

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
  | "message.dropped"
  | "message.complete";

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
 * - Optionally logs all operations via ILogger (#223)
 */
export class TinyBus {
  private providers: Map<string, Provider> = new Map();
  private router: Router;
  private started = false;
  private eventListeners: Map<TinyBusEvent, Set<EventListener>> = new Map();
  private logger?: ILogger;

  constructor(router?: Router, logger?: ILogger) {
    this.router = router ?? new DefaultRouter();
    this.logger = logger;
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

    const providerIds = Array.from(this.providers.keys());
    this.logger?.debug(`[TINYBUS] Starting with ${providerIds.length} providers: ${providerIds.join(", ")}`);

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
    this.logger?.debug(`[TINYBUS] Started successfully`);
    this.emit("tinybus.started", {});
  }

  /**
   * Stop TinyBus and all providers
   */
  async stop(): Promise<void> {
    if (!this.started) {
      return;
    }

    this.logger?.debug(`[TINYBUS] Stopping...`);
    this.started = false;

    // Stop all providers
    const stopPromises = Array.from(this.providers.values()).map((p) =>
      p.stop()
    );
    await Promise.all(stopPromises);

    this.logger?.debug(`[TINYBUS] Stopped`);
    this.emit("tinybus.stopped", {});
  }

  /**
   * Publish a message to TinyBus
   */
  async publish(message: Message): Promise<void> {
    if (!this.started) {
      throw new Error("TinyBus not started");
    }

    const startTime = Date.now();
    this.emit("message.outbound", { message });

    // Route message to target providers
    const providers = Array.from(this.providers.values());
    const targets = this.router.route(message, providers);

    if (targets.length === 0) {
      this.logger?.debug(
        `[TINYBUS] Dropped: type=${message.type} source=${message.source ?? "unknown"} destination=${message.destination ?? "broadcast"} reason=no_target_providers`
      );
      this.emit("message.dropped", { message, reason: "No target providers" });
      return;
    }

    // Send to all target providers with per-provider timing
    let successCount = 0;
    let errorCount = 0;
    const sendPromises = targets.map(async (provider) => {
      const handlerStart = Date.now();
      try {
        await provider.send(message);
        const handlerDurationMs = Date.now() - handlerStart;
        successCount++;
        this.logger?.debug(
          `[TINYBUS] Routed: type=${message.type} → provider=${provider.id} id=${message.id} durationMs=${handlerDurationMs}`
        );
        this.emit("message.routed", { message, provider: provider.id, durationMs: handlerDurationMs });
      } catch (error) {
        const handlerDurationMs = Date.now() - handlerStart;
        errorCount++;
        const errorMsg = error instanceof Error ? error.message : "Unknown error";
        this.logger?.warn(
          `[TINYBUS] Error: type=${message.type} provider=${provider.id} error=${errorMsg} durationMs=${handlerDurationMs}`
        );
        this.emit("message.error", {
          message,
          provider: provider.id,
          error: errorMsg,
          durationMs: handlerDurationMs,
        });
      }
    });

    await Promise.all(sendPromises);

    const totalDurationMs = Date.now() - startTime;
    this.emit("message.complete", {
      message,
      durationMs: totalDurationMs,
      routedTo: targets.length,
      successCount,
      errorCount,
    });
  }

  /**
   * Handle inbound message from a provider
   */
  private async handleInboundMessage(message: Message): Promise<void> {
    this.logger?.debug(
      `[TINYBUS] Inbound: type=${message.type} source=${message.source ?? "unknown"} id=${message.id}`
    );
    this.emit("message.inbound", { message });

    try {
      await this.publish(message);
    } catch (error) {
      const errorMsg = error instanceof Error ? error.message : "Unknown error";
      this.logger?.warn(
        `[TINYBUS] Inbound routing failed: type=${message.type} error=${errorMsg}`
      );
      this.emit("message.error", {
        message,
        error: errorMsg,
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
  protected emit(event: TinyBusEvent, data: unknown): void {
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
