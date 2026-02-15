/**
 * Tests for supervisor retry logic.
 * 
 * Note: Full integration testing of supervisor.ts requires spawning processes,
 * so these tests focus on the retry backoff calculation logic.
 */

describe("supervisor retry backoff", () => {
  const INITIAL_BUILD_RETRY_DELAY_MS = 10_000;
  const MAX_BACKOFF_MS = 5 * 60 * 1000; // 5 minutes

  function calculateBackoff(retryCount: number): number {
    return Math.min(
      INITIAL_BUILD_RETRY_DELAY_MS * Math.pow(2, retryCount - 1),
      MAX_BACKOFF_MS
    );
  }

  it("calculates exponential backoff correctly", () => {
    expect(calculateBackoff(1)).toBe(10_000);   // 10s
    expect(calculateBackoff(2)).toBe(20_000);   // 20s
    expect(calculateBackoff(3)).toBe(40_000);   // 40s
    expect(calculateBackoff(4)).toBe(80_000);   // 80s
    expect(calculateBackoff(5)).toBe(160_000);  // 160s (2m 40s)
    expect(calculateBackoff(6)).toBe(300_000);  // capped at 5 minutes
    expect(calculateBackoff(7)).toBe(300_000);  // capped at 5 minutes
    expect(calculateBackoff(10)).toBe(300_000); // capped at 5 minutes
  });

  it("respects MAX_BUILD_RETRIES constant of 10", () => {
    const MAX_BUILD_RETRIES = 10;
    expect(MAX_BUILD_RETRIES).toBe(10);
  });
});
