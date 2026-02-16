/**
 * TinyBus Message
 *
 * Minimal envelope for routing messages between providers.
 */
export interface Message {
  /** Unique message identifier (GUID or timestamp-based) */
  id: string;

  /** URI-like routing key (e.g., "agent.command.exec", "system.health.ping") */
  type: string;

  /** Schema version (currently "v1") */
  schema: string;

  /** Message timestamp (milliseconds since epoch) */
  timestamp: number;

  /** Source provider id (optional) */
  source?: string;

  /** Destination provider id or logical target (optional - broadcast if omitted) */
  destination?: string;

  /** Message payload (optional) */
  payload?: unknown;

  /** Metadata for extensibility (optional) */
  meta?: Record<string, unknown>;
}

/**
 * Create a new message with generated id and timestamp
 */
export function createMessage(params: {
  type: string;
  source?: string;
  destination?: string;
  payload?: unknown;
  meta?: Record<string, unknown>;
}): Message {
  return {
    id: generateMessageId(),
    type: params.type,
    schema: "v1",
    timestamp: Date.now(),
    source: params.source,
    destination: params.destination,
    payload: params.payload,
    meta: params.meta,
  };
}

/**
 * Generate a unique message ID
 * Uses timestamp + random suffix for uniqueness within runtime
 */
function generateMessageId(): string {
  const timestamp = Date.now();
  const random = Math.random().toString(36).substring(2, 9);
  return `${timestamp}-${random}`;
}
