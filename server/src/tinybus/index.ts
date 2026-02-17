/**
 * TinyBus - Lightweight message routing subsystem
 *
 * Export core components for use in the application.
 */

// Core types and interfaces
export type { Message } from "./core/Message";
export { createMessage } from "./core/Message";
export type { Provider } from "./core/Provider";
export type { Router } from "./core/Router";
export { DefaultRouter } from "./core/Router";
export type { TinyBusEvent, EventListener } from "./core/TinyBus";
export { TinyBus } from "./core/TinyBus";

// Providers
export { MemoryProvider } from "./providers/MemoryProvider";
export { SessionInjectionProvider } from "./providers/SessionInjectionProvider";
export { ChatMessageProvider } from "./providers/ChatMessageProvider";
// Note: AgoraProvider removed - replaced by AgoraOutboundProvider in agora/ module

// MCP Server
export { createTinyBusMcpServer, createInMemoryTinyBusMcpServer, startTinyBusMcpHttpServer } from "../mcp/TinyBusMcpServer";
