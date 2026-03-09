/**
 * Thrown when the Claude SDK (or any launcher) reports a rate limit rejection.
 * The message contains the buildRateLimitText() string so that parseRateLimitReset
 * can extract the reset timestamp from it.
 */
export class RateLimitError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RateLimitError";
  }
}
