import { truncateMiddle, fitToContextWindow } from "../../../src/agents/openrouter/PromptTruncator";

describe("truncateMiddle", () => {
  it("returns text unchanged when within maxChars", () => {
    const text = "hello world";
    expect(truncateMiddle(text, 100)).toBe(text);
  });

  it("returns text unchanged when exactly at maxChars", () => {
    const text = "abcde";
    expect(truncateMiddle(text, text.length)).toBe(text);
  });

  it("inserts truncation marker when text exceeds maxChars", () => {
    const text = "a".repeat(1000);
    const result = truncateMiddle(text, 200);
    expect(result).toContain("[content truncated");
    expect(result.length).toBeLessThanOrEqual(200 + 5); // marker may slightly exceed due to length
  });

  it("preserves the beginning of the text", () => {
    const text = "START" + "x".repeat(1000) + "END";
    const result = truncateMiddle(text, 100);
    expect(result.startsWith("START")).toBe(true);
  });

  it("preserves the end of the text", () => {
    const text = "START" + "x".repeat(1000) + "END";
    const result = truncateMiddle(text, 100);
    expect(result.endsWith("END")).toBe(true);
  });

  it("head is larger than tail (70/30 split)", () => {
    const text = "A".repeat(5000);
    const result = truncateMiddle(text, 500);
    const [head, tail] = result.split(/\.\.\.\[content truncated[^\]]*\]\.\.\./);
    expect(head.length).toBeGreaterThan(tail.length);
  });
});

describe("fitToContextWindow", () => {
  it("passes through unchanged when content fits", () => {
    const system = "short system";
    const user = "short user";
    const result = fitToContextWindow(system, user, 131072);
    expect(result.systemPrompt).toBe(system);
    expect(result.userMessage).toBe(user);
  });

  it("truncates user message when total exceeds budget", () => {
    const contextWindowTokens = 1000; // very small for testing
    const system = "s".repeat(100);
    // Budget: (1000 - 4096) would be negative, so let's use a bigger window
    // Budget with 10000 tokens: (10000 - 4096) * 4 * 0.9 = 5904 * 3.6 = ~21254 chars
    const ctx = 10000;
    const budget = Math.floor((ctx - 4096) * 4 * 0.9); // ~21254
    const user = "u".repeat(budget * 2); // way over budget

    const result = fitToContextWindow(system, user, ctx);

    expect(result.userMessage.length).toBeLessThan(user.length);
    expect(result.userMessage).toContain("[content truncated");
  });

  it("does not truncate system when it fits in its share", () => {
    const ctx = 131072;
    const budget = Math.floor((ctx - 4096) * 4 * 0.9);
    const system = "s".repeat(1000); // small system prompt
    const user = "u".repeat(budget * 2); // huge user message

    const result = fitToContextWindow(system, user, ctx);

    // System prompt is small enough to fit without truncation
    expect(result.systemPrompt).toBe(system);
    expect(result.userMessage).toContain("[content truncated");
  });

  it("truncates both when system is also very large", () => {
    const ctx = 10000;
    const budget = Math.floor((ctx - 4096) * 4 * 0.9);
    const system = "s".repeat(budget); // large system
    const user = "u".repeat(budget); // large user

    const result = fitToContextWindow(system, user, ctx);

    expect(result.systemPrompt.length).toBeLessThan(system.length);
    expect(result.userMessage.length).toBeLessThan(user.length);
  });

  it("total output length is within budget", () => {
    const ctx = 131072;
    const budget = Math.floor((ctx - 4096) * 4 * 0.9);
    const system = "s".repeat(50000);
    const user = "u".repeat(500000);

    const result = fitToContextWindow(system, user, ctx);

    expect(result.systemPrompt.length + result.userMessage.length).toBeLessThanOrEqual(budget + 200);
  });
});
