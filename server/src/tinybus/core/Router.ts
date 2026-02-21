import { Message } from "./Message";
import { Provider } from "./Provider";

/**
 * Router interface for routing messages to providers
 */
export interface Router {
  /**
   * Route a message to target providers
   * @param message - Message to route
   * @param providers - Available providers
   * @returns Array of target providers
   */
  route(message: Message, providers: Provider[]): Provider[];
}

/**
 * Default router implementation
 *
 * Routing logic:
 * 1. Direct routing: If destination matches a provider id, deliver only to that provider
 * 2. Broadcast: If no destination, deliver to all providers except source
 */
export class DefaultRouter implements Router {
  route(message: Message, providers: Provider[]): Provider[] {
    // Direct routing: destination matches provider id
    if (message.destination) {
      const target = providers.find((p) => p.id === message.destination);
      return target ? [target] : [];
    }

    // Broadcast: deliver to all providers except source
    // Don't route agora.* messages to loopback to prevent duplicate outbound sends
    return providers.filter((p) => {
      if (p.id === message.source) return false;
      if (p.id === "loopback" && message.type.startsWith("agora.")) return false;
      return true;
    });
  }
}
