/**
 * Interface for injecting messages into the agent loop.
 * Allows mocking message injection in tests.
 * Returns true if delivered to an active session, false if queued or dropped.
 */
export interface IMessageInjector {
  injectMessage(message: string): boolean;
}
