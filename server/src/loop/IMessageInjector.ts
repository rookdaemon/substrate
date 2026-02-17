/**
 * Interface for injecting messages into the agent loop.
 * Allows mocking message injection in tests.
 */
export interface IMessageInjector {
  injectMessage(message: string): void;
}
