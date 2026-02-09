// Jest mock for @anthropic-ai/claude-agent-sdk
// The real SDK is an .mjs bundle that ts-jest cannot transform.
// This mock prevents import failures in tests that transitively depend on createApplication.ts.

export function query() {
  throw new Error("SDK query() should not be called in tests — use InMemorySessionLauncher");
}
