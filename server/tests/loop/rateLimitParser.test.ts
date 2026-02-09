import { parseRateLimitReset } from "../../src/loop/rateLimitParser";

describe("parseRateLimitReset", () => {
  it("parses 'resets 7pm (UTC)' from rate limit message", () => {
    const result = parseRateLimitReset(
      "You've hit your limit · resets 7pm (UTC)",
      new Date("2026-02-09T18:30:00Z"),
    );
    expect(result).toEqual(new Date("2026-02-09T19:00:00Z"));
  });

  it("parses 'resets 3am (UTC)' crossing midnight", () => {
    const result = parseRateLimitReset(
      "You've hit your limit · resets 3am (UTC)",
      new Date("2026-02-09T23:30:00Z"),
    );
    // 3am UTC is next day
    expect(result).toEqual(new Date("2026-02-10T03:00:00Z"));
  });

  it("parses 12pm (UTC) as noon", () => {
    const result = parseRateLimitReset(
      "You've hit your limit · resets 12pm (UTC)",
      new Date("2026-02-09T10:00:00Z"),
    );
    expect(result).toEqual(new Date("2026-02-09T12:00:00Z"));
  });

  it("parses 12am (UTC) as midnight", () => {
    const result = parseRateLimitReset(
      "You've hit your limit · resets 12am (UTC)",
      new Date("2026-02-09T22:00:00Z"),
    );
    expect(result).toEqual(new Date("2026-02-10T00:00:00Z"));
  });

  it("returns null for non-rate-limit messages", () => {
    expect(parseRateLimitReset("Hello world", new Date())).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(parseRateLimitReset("", new Date())).toBeNull();
  });

  it("returns null for undefined", () => {
    expect(parseRateLimitReset(undefined, new Date())).toBeNull();
  });

  it("handles rate limit in longer output text", () => {
    const result = parseRateLimitReset(
      "Some prefix text\nYou've hit your limit · resets 5pm (UTC)\nSome suffix",
      new Date("2026-02-09T14:00:00Z"),
    );
    expect(result).toEqual(new Date("2026-02-09T17:00:00Z"));
  });
});
