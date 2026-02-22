/**
 * Standalone Agora relay entry point.
 *
 * Starts WebSocket relay and optional REST API using the same code as the
 * standalone agora-relay package (@rookdaemon/agora runRelay).
 *
 * Environment variables:
 *   PORT                     — WebSocket port (default: 3001); REST runs on PORT+1
 *   AGORA_RELAY_JWT_SECRET   — When set, REST API is enabled (required for REST)
 *   AGORA_JWT_EXPIRY_SECONDS — JWT expiry in seconds (default: 3600)
 */

import { runRelay } from '@rookdaemon/agora';

async function main(): Promise<void> {
  const wsPort = parseInt(process.env.PORT ?? '3001', 10);

  const { relay, httpServer } = await runRelay({
    wsPort,
    restPort: wsPort + 1,
    enableRest: Boolean(process.env.AGORA_RELAY_JWT_SECRET),
  });

  console.log(`Agora relay WebSocket server running on ws://0.0.0.0:${wsPort}`);
  if (httpServer) {
    console.log(`Agora relay REST API running on http://0.0.0.0:${wsPort + 1}`);
  }

  const shutdown = async (): Promise<void> => {
    console.log('Shutting down...');
    await relay.stop();
    if (httpServer) {
      httpServer.close();
    }
    process.exit(0);
  };

  process.once('SIGTERM', () => void shutdown());
  process.once('SIGINT', () => void shutdown());
}

main().catch((err: unknown) => {
  console.error('Fatal error:', err);
  process.exit(1);
});
