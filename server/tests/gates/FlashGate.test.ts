import { FlashGate } from "../../src/gates/FlashGate";
import type { FlashGateResult } from "../../src/gates/IFlashGate";
import type { IClock } from "../../src/substrate/abstractions/IClock";
import type { ILogger } from "../../src/logging";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

// ---------------------------------------------------------------------------
// Test doubles
// ---------------------------------------------------------------------------

class FixedClock implements IClock {
  constructor(private time: Date) {}
  now(): Date {
    return this.time;
  }
}

class NullLogger implements ILogger {
  debug(_: string): void {}
  warn(_: string): void {}
  error(_: string): void {}
  verbose(_: string): void {}
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const BASE_FROM = "302a300506032b6570032100abcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcdefabcd";
const BASE_TO = ["302a300506032b6570032100dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd"];

function makeEnvelope(overrides: Partial<Envelope> = {}): Envelope {
  return {
    id: "test-envelope-id",
    type: "dm",
    from: BASE_FROM,
    to: BASE_TO,
    timestamp: new Date("2025-06-15T10:30:00.000Z").getTime(),
    payload: { text: "hello" },
    signature: "test-sig",
    ...overrides,
  };
}

const TOLERANCE_MS = 5 * 60 * 1000; // must match FlashGate constant

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe("FlashGate", () => {
  const logger = new NullLogger();

  describe("non-gated message types", () => {
    it("returns PASS for 'request' type without inspecting timestamp", async () => {
      // Far-future timestamp would fail the timestamp check, but type is not gated.
      const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "request",
        timestamp: new Date("2020-01-01T00:00:00.000Z").getTime(), // way out of window
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("PASS");
    });

    it("returns PASS for 'announce' type", async () => {
      const clock = new FixedClock(new Date("2025-06-15T10:00:00.000Z"));
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "announce",
        timestamp: new Date("2020-01-01T00:00:00.000Z").getTime(),
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("PASS");
    });
  });

  describe("timestamp anomaly check — 'dm' type", () => {
    it("returns PASS when envelope timestamp exactly matches now", async () => {
      const now = new Date("2025-06-15T10:30:00.000Z");
      const clock = new FixedClock(now);
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({ type: "dm", timestamp: now.getTime() });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("PASS");
    });

    it("returns PASS for timestamp within tolerance window (same day, mid-morning)", async () => {
      // Issue C regression test: a message sent at 10:30 with clock at 10:31 must PASS.
      // The bug would have compared against midnight of 2025-06-15 → drift ~10.5 h → ESCALATE.
      const clockTime = new Date("2025-06-15T10:31:00.000Z");
      const clock = new FixedClock(clockTime);
      const gate = new FlashGate(clock, logger);
      const envelopeTimestamp = new Date("2025-06-15T10:30:00.000Z").getTime();
      const envelope = makeEnvelope({ type: "dm", timestamp: envelopeTimestamp });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("PASS");
      expect(result.reason).toBeUndefined();
    });

    it("returns PASS for timestamp 1 ms inside tolerance boundary", async () => {
      const now = new Date("2025-06-15T12:00:00.000Z");
      const clock = new FixedClock(now);
      const gate = new FlashGate(clock, logger);
      // Exactly at the edge — one millisecond inside tolerance.
      const envelope = makeEnvelope({
        type: "dm",
        timestamp: now.getTime() - (TOLERANCE_MS - 1),
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("PASS");
    });

    it("returns ESCALATE for timestamp 1 ms outside tolerance boundary", async () => {
      const now = new Date("2025-06-15T12:00:00.000Z");
      const clock = new FixedClock(now);
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "dm",
        timestamp: now.getTime() - (TOLERANCE_MS + 1),
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("ESCALATE");
      expect(result.reason).toContain("Timestamp anomaly");
    });

    it("returns ESCALATE for timestamp far in the past", async () => {
      const clock = new FixedClock(new Date("2025-06-15T12:00:00.000Z"));
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "dm",
        timestamp: new Date("2025-06-01T00:00:00.000Z").getTime(), // 14 days ago
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("ESCALATE");
    });

    it("returns ESCALATE for timestamp far in the future", async () => {
      const clock = new FixedClock(new Date("2025-06-15T12:00:00.000Z"));
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "dm",
        timestamp: new Date("2025-06-16T00:00:00.000Z").getTime(), // 12 h ahead
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("ESCALATE");
    });
  });

  describe("timestamp anomaly check — 'publish' type", () => {
    it("returns PASS for valid same-day publish timestamp", async () => {
      const clockTime = new Date("2025-06-15T18:05:00.000Z");
      const clock = new FixedClock(clockTime);
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "publish",
        timestamp: new Date("2025-06-15T18:04:30.000Z").getTime(), // 30 s ago
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("PASS");
    });

    it("returns ESCALATE for publish timestamp outside valid window", async () => {
      const clock = new FixedClock(new Date("2025-06-15T18:00:00.000Z"));
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "publish",
        timestamp: new Date("2025-06-14T00:00:00.000Z").getTime(), // 42 h ago
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("ESCALATE");
    });
  });

  describe("Issue C regression — date-string truncation bug", () => {
    /**
     * The bug: `Date.parse(timestamp.slice(0, 10))` converts the envelope's
     * ISO string "2025-06-15T10:30:00.000Z" to "2025-06-15" (YYYY-MM-DD),
     * which Date.parse resolves to midnight UTC.  Every dm sent after midnight
     * on the same day appears to be "in the future" relative to midnight,
     * triggering a false ESCALATE.
     *
     * The fix: use the full ISO string so the epoch equals the actual send time.
     */
    it("does NOT false-positive for a message sent mid-morning (same-day uniform distribution)", async () => {
      // Simulate FP11-12 / FP18 / FP21 pattern: message sent at 10:30, read at 10:30+30s.
      const sendTime = new Date("2025-06-15T10:30:00.000Z");
      const readTime = new Date("2025-06-15T10:30:30.000Z"); // 30 s later
      const clock = new FixedClock(readTime);
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "dm",
        timestamp: sendTime.getTime(),
      });

      const result: FlashGateResult = await gate.evaluate(envelope);

      // With the bug: Date.parse("2025-06-15") = midnight → drift ≈ 10.5 h → ESCALATE
      // With the fix: epoch = 10:30:00 UTC → drift = 30 s → PASS
      expect(result.decision).toBe("PASS");
    });

    it("does NOT false-positive for a message sent late at night (same-day)", async () => {
      const sendTime = new Date("2025-06-15T23:55:00.000Z");
      const readTime = new Date("2025-06-15T23:55:10.000Z");
      const clock = new FixedClock(readTime);
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "dm",
        timestamp: sendTime.getTime(),
      });

      const result = await gate.evaluate(envelope);

      // With bug: drift ≈ 23.9 h → ESCALATE. With fix: 10 s → PASS.
      expect(result.decision).toBe("PASS");
    });

    it("still ESCALATEs when timestamp is genuinely anomalous (cross-day boundary)", async () => {
      // A message with yesterday's timestamp is a real anomaly, not a false positive.
      const clock = new FixedClock(new Date("2025-06-15T10:30:00.000Z"));
      const gate = new FlashGate(clock, logger);
      const envelope = makeEnvelope({
        type: "dm",
        timestamp: new Date("2025-06-14T10:30:00.000Z").getTime(), // 24 h ago
      });

      const result = await gate.evaluate(envelope);

      expect(result.decision).toBe("ESCALATE");
      expect(result.reason).toMatch(/Timestamp anomaly/);
    });
  });
});
