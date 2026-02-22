/**
 * Agora relay module — start the same relay as the standalone agora-relay using @rookdaemon/agora.
 *
 * Use this when substrate (or a script) needs to run a relay in-process:
 * WebSocket relay + optional REST API (when AGORA_RELAY_JWT_SECRET is set).
 *
 * Environment variables (same as agora's runRelay):
 *   PORT                     — WebSocket port (default: 3001); REST runs on PORT+1
 *   AGORA_RELAY_JWT_SECRET   — When set, REST API is enabled (required for REST)
 *   AGORA_JWT_EXPIRY_SECONDS — JWT expiry in seconds (default: 3600)
 */

export { runRelay, type RunRelayOptions } from '@rookdaemon/agora';
export type { RelayServerOptions } from '@rookdaemon/agora';
