import {
  parseHeartbeat,
  serialiseHeartbeat,
  detectScheduleType,
  matchesCron,
  sameUtcMinute,
  nextCronOccurrence,
  computeNextWakeTime,
  validateHeartbeatContent,
  IMPLICIT_HEARTBEAT_ENTRIES,
  withImplicitEntries,
} from "../../src/loop/HeartbeatParser";

describe("detectScheduleType", () => {
  it("returns 'once' for @once", () => {
    expect(detectScheduleType("@once")).toBe("once");
  });

  it("returns 'condition-only' for empty string", () => {
    expect(detectScheduleType("")).toBe("condition-only");
  });

  it("returns 'iso' for ISO timestamps", () => {
    expect(detectScheduleType("2026-03-09T20:00Z")).toBe("iso");
    expect(detectScheduleType("2026-03-09T20:00:00Z")).toBe("iso");
    expect(detectScheduleType("2026-12-31T23:59")).toBe("iso");
  });

  it("returns 'cron' for 5-field cron expressions", () => {
    expect(detectScheduleType("*/30 * * * *")).toBe("cron");
    expect(detectScheduleType("0 9 * * 1")).toBe("cron");
    expect(detectScheduleType("*/5 */2 * * *")).toBe("cron");
  });

  it("returns 'unknown' for unrecognised strings", () => {
    expect(detectScheduleType("tomorrow")).toBe("unknown");
    expect(detectScheduleType("1 2 3")).toBe("unknown");
  });
});

describe("matchesCron", () => {
  // 2026-03-09T20:30:00Z — Monday, minute=30, hour=20, dom=9, month=3, dow=1
  const date = new Date("2026-03-09T20:30:00Z");

  it("matches wildcard expression", () => {
    expect(matchesCron("* * * * *", date)).toBe(true);
  });

  it("matches */30 on minute 30", () => {
    expect(matchesCron("*/30 * * * *", date)).toBe(true);
  });

  it("does not match */30 on minute 31", () => {
    const d = new Date("2026-03-09T20:31:00Z");
    expect(matchesCron("*/30 * * * *", d)).toBe(false);
  });

  it("matches exact minute", () => {
    expect(matchesCron("30 * * * *", date)).toBe(true);
    expect(matchesCron("29 * * * *", date)).toBe(false);
  });

  it("matches hour field", () => {
    expect(matchesCron("* 20 * * *", date)).toBe(true);
    expect(matchesCron("* 19 * * *", date)).toBe(false);
  });

  it("matches day-of-month field", () => {
    expect(matchesCron("* * 9 * *", date)).toBe(true);
    expect(matchesCron("* * 10 * *", date)).toBe(false);
  });

  it("matches month field", () => {
    expect(matchesCron("* * * 3 *", date)).toBe(true);
    expect(matchesCron("* * * 4 *", date)).toBe(false);
  });

  it("matches day-of-week field (1=Monday)", () => {
    expect(matchesCron("* * * * 1", date)).toBe(true);
    expect(matchesCron("* * * * 0", date)).toBe(false);
  });

  it("matches range fields", () => {
    expect(matchesCron("20-40 * * * *", date)).toBe(true);
    expect(matchesCron("31-59 * * * *", date)).toBe(false);
  });

  it("matches comma-separated values", () => {
    expect(matchesCron("15,30,45 * * * *", date)).toBe(true);
    expect(matchesCron("15,45 * * * *", date)).toBe(false);
  });

  it("returns false for invalid 5-field cron", () => {
    expect(matchesCron("bad expression here", date)).toBe(false);
    expect(matchesCron("* * * *", date)).toBe(false); // only 4 fields
  });
});

describe("sameUtcMinute", () => {
  it("returns true for same UTC minute", () => {
    const a = new Date("2026-03-09T20:30:00Z");
    const b = new Date("2026-03-09T20:30:59Z");
    expect(sameUtcMinute(a, b)).toBe(true);
  });

  it("returns false for different UTC minutes", () => {
    const a = new Date("2026-03-09T20:30:00Z");
    const b = new Date("2026-03-09T20:31:00Z");
    expect(sameUtcMinute(a, b)).toBe(false);
  });
});

describe("parseHeartbeat", () => {
  it("returns empty array for empty content", () => {
    expect(parseHeartbeat("")).toHaveLength(0);
    expect(parseHeartbeat("\n\n")).toHaveLength(0);
  });

  it("parses a single ISO timestamp entry", () => {
    const content = `# 2026-03-09T20:00Z\nBishop and Nova are back.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("2026-03-09T20:00Z");
    expect(entries[0].condition).toBeUndefined();
    expect(entries[0].payload).toBe("Bishop and Nova are back.");
  });

  it("parses a cron entry", () => {
    const content = `# */30 * * * *\nPublish pending queue.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("*/30 * * * *");
  });

  it("parses @once entry", () => {
    const content = `# @once\nFirst-boot: read ID.md.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("@once");
  });

  it("parses condition-only entry", () => {
    const content = `# when: peer:nova.available\nNova is back.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("");
    expect(entries[0].condition).toBe("peer:nova.available");
    expect(entries[0].payload).toBe("Nova is back.");
  });

  it("parses schedule + condition entry", () => {
    const content = `# 2026-03-09T20:00Z when: peer:nova.available\nCheck FP9.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("2026-03-09T20:00Z");
    expect(entries[0].condition).toBe("peer:nova.available");
  });

  it("parses agora_peer_message condition", () => {
    const content = `# when: agora_peer_message\nNew message arrived.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("");
    expect(entries[0].condition).toBe("agora_peer_message");
  });

  it("parses AND condition", () => {
    const content = `# when: peer:nova.available AND peer:bishop.available\nBoth back.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].condition).toBe("peer:nova.available AND peer:bishop.available");
  });

  it("parses multiple entries", () => {
    const content = `# 2026-03-09T20:00Z\nFirst entry.

# */30 * * * *
Second entry.

# when: agora_peer_message
Third entry.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(3);
    expect(entries[0].schedule).toBe("2026-03-09T20:00Z");
    expect(entries[1].schedule).toBe("*/30 * * * *");
    expect(entries[2].condition).toBe("agora_peer_message");
  });

  it("preserves multi-line payloads", () => {
    const content = `# @once\nLine one.\nLine two.\nLine three.`;
    const entries = parseHeartbeat(content);
    expect(entries[0].payload).toBe("Line one.\nLine two.\nLine three.");
  });

  it("skips entries with no payload", () => {
    const content = `# @once\n\n# */5 * * * *\nActual payload.`;
    const entries = parseHeartbeat(content);
    expect(entries).toHaveLength(1);
    expect(entries[0].schedule).toBe("*/5 * * * *");
  });
});

describe("serialiseHeartbeat", () => {
  it("returns empty string for empty entries", () => {
    expect(serialiseHeartbeat([])).toBe("");
  });

  it("round-trips a single entry", () => {
    const content = "# @once\nHello world.";
    const entries = parseHeartbeat(content);
    const result = serialiseHeartbeat(entries);
    expect(result).toBe("# @once\nHello world.\n");
  });

  it("round-trips condition-only entry", () => {
    const entries = parseHeartbeat("# when: peer:nova.available\nNova back.");
    const result = serialiseHeartbeat(entries);
    expect(result).toContain("# when: peer:nova.available");
  });

  it("round-trips schedule+condition entry", () => {
    const entries = parseHeartbeat("# */30 * * * * when: agora_peer_message\nCheck messages.");
    const result = serialiseHeartbeat(entries);
    expect(result).toContain("*/30 * * * * when: agora_peer_message");
  });

  it("joins multiple entries with blank lines", () => {
    const entries = [
      { schedule: "@once", payload: "First." },
      { schedule: "*/5 * * * *", payload: "Second." },
    ];
    const result = serialiseHeartbeat(entries);
    expect(result).toBe("# @once\nFirst.\n\n# */5 * * * *\nSecond.\n");
  });
});

describe("nextCronOccurrence", () => {
  it("finds the next minute matching */30", () => {
    // 20:15 → next match is 20:30
    const now = new Date("2026-03-09T20:15:00Z");
    const next = nextCronOccurrence("*/30 * * * *", now);
    expect(next).toEqual(new Date("2026-03-09T20:30:00Z"));
  });

  it("finds the next minute matching a specific minute", () => {
    // 20:30 → next match of minute=45 is 20:45
    const now = new Date("2026-03-09T20:30:00Z");
    const next = nextCronOccurrence("45 * * * *", now);
    expect(next).toEqual(new Date("2026-03-09T20:45:00Z"));
  });

  it("wraps to the next hour", () => {
    // 20:50 → next match of minute=15 is 21:15
    const now = new Date("2026-03-09T20:50:00Z");
    const next = nextCronOccurrence("15 * * * *", now);
    expect(next).toEqual(new Date("2026-03-09T21:15:00Z"));
  });

  it("finds the next matching hour", () => {
    // 20:30 → "0 9 * * *" fires at 09:00 next day
    const now = new Date("2026-03-09T20:30:00Z");
    const next = nextCronOccurrence("0 9 * * *", now);
    expect(next).toEqual(new Date("2026-03-10T09:00:00Z"));
  });

  it("finds next matching day-of-week", () => {
    // Monday 20:30 → "0 9 * * 3" = Wednesday 09:00
    const now = new Date("2026-03-09T20:30:00Z"); // Monday
    const next = nextCronOccurrence("0 9 * * 3", now);
    expect(next).toEqual(new Date("2026-03-11T09:00:00Z")); // Wednesday
  });

  it("starts from the next minute, not the current one", () => {
    // 20:30:00 with cron "30 20 * * *" should NOT match 20:30 (already current)
    const now = new Date("2026-03-09T20:30:00Z");
    const next = nextCronOccurrence("30 20 * * *", now);
    expect(next).toEqual(new Date("2026-03-10T20:30:00Z"));
  });

  it("returns null for impossible cron within 7 days", () => {
    // Month 13 doesn't exist
    const now = new Date("2026-03-09T20:30:00Z");
    const next = nextCronOccurrence("0 0 1 13 *", now);
    expect(next).toBeNull();
  });
});

describe("computeNextWakeTime", () => {
  it("returns null for empty entries", () => {
    const now = new Date("2026-03-09T20:30:00Z");
    expect(computeNextWakeTime([], now)).toBeNull();
  });

  it("returns null for condition-only and @once entries", () => {
    const now = new Date("2026-03-09T20:30:00Z");
    const entries = parseHeartbeat(
      "# @once\nFirst.\n\n# when: peer:nova.available\nSecond."
    );
    expect(computeNextWakeTime(entries, now)).toBeNull();
  });

  it("returns ISO timestamp if in the future", () => {
    const now = new Date("2026-03-09T20:00:00Z");
    const entries = parseHeartbeat("# 2026-03-09T21:00:00Z\nWake up.");
    const result = computeNextWakeTime(entries, now);
    expect(result).toEqual(new Date("2026-03-09T21:00:00Z"));
  });

  it("skips ISO timestamp if in the past", () => {
    const now = new Date("2026-03-09T22:00:00Z");
    const entries = parseHeartbeat("# 2026-03-09T21:00:00Z\nWake up.");
    expect(computeNextWakeTime(entries, now)).toBeNull();
  });

  it("returns the next cron occurrence", () => {
    const now = new Date("2026-03-09T20:15:00Z");
    const entries = parseHeartbeat("# */30 * * * *\nCheck things.");
    const result = computeNextWakeTime(entries, now);
    expect(result).toEqual(new Date("2026-03-09T20:30:00Z"));
  });

  it("picks the earliest of multiple entries", () => {
    const now = new Date("2026-03-09T20:15:00Z");
    const entries = parseHeartbeat(
      "# 2026-03-09T22:00:00Z\nLater.\n\n# */30 * * * *\nSooner."
    );
    const result = computeNextWakeTime(entries, now);
    // */30 next fires at 20:30, ISO fires at 22:00 → 20:30 is earliest
    expect(result).toEqual(new Date("2026-03-09T20:30:00Z"));
  });
});

describe("validateHeartbeatContent", () => {
  it("accepts valid content with # <schedule> headers", () => {
    const content = `# 0 * * * *\npayload\n\n# when: peer:bishop.available\nother payload\n`;
    expect(validateHeartbeatContent(content).valid).toBe(true);
  });

  it("rejects content block missing # header (orphaned payload before first header)", () => {
    const content = `orphaned line\n# 0 * * * *\npayload\n`;
    const result = validateHeartbeatContent(content);
    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe("MISSING_HEADER");
    expect(result.errors[0].message).toContain("HEARTBEAT_WRITE_ERROR");
  });

  it("rejects content with only payload (no header at all)", () => {
    const content = `just payload\nno header\n`;
    const result = validateHeartbeatContent(content);
    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe("MISSING_HEADER");
  });

  it("accepts empty content", () => {
    expect(validateHeartbeatContent("").valid).toBe(true);
    expect(validateHeartbeatContent("\n\n").valid).toBe(true);
  });

  it("reports UNKNOWN_SCHEDULE for unrecognised schedule expression", () => {
    const content = `# every-tuesday\npayload\n`;
    const result = validateHeartbeatContent(content);
    expect(result.valid).toBe(false);
    expect(result.errors[0].type).toBe("UNKNOWN_SCHEDULE");
  });

  it("collects all errors across multiple invalid blocks", () => {
    const content = `orphan1\n# bad-schedule\npayload1\norphan2\n`;
    const result = validateHeartbeatContent(content);
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThanOrEqual(2);
  });

  it("accepts @once header", () => {
    expect(validateHeartbeatContent("# @once\npayload\n").valid).toBe(true);
  });

  it("accepts ISO timestamp header", () => {
    expect(validateHeartbeatContent("# 2026-06-01T09:00Z\npayload\n").valid).toBe(true);
  });

  it("accepts condition-only header (bare #)", () => {
    expect(validateHeartbeatContent("# when: peer:nova.available\npayload\n").valid).toBe(true);
  });

  it("includes preview of orphaned content in error", () => {
    const content = `some orphaned content here\n# 0 * * * *\npayload\n`;
    const result = validateHeartbeatContent(content);
    expect(result.errors[0].preview).toContain("some orphaned content");
  });

  it("truncates preview to 80 chars", () => {
    const longOrphan = "x".repeat(200);
    const result = validateHeartbeatContent(longOrphan);
    expect(result.errors[0].preview.length).toBeLessThanOrEqual(80);
  });

  it("error message contains required format example and rejection text", () => {
    const result = validateHeartbeatContent("orphaned\n");
    const msg = result.errors[0].message;
    expect(msg).toContain("HEARTBEAT_WRITE_ERROR");
    expect(msg).toContain("# <schedule>");
    expect(msg).toContain("Entry rejected. Correct and resubmit.");
  });
});

describe("IMPLICIT_HEARTBEAT_ENTRIES", () => {
  it("contains at least one cron entry", () => {
    expect(IMPLICIT_HEARTBEAT_ENTRIES.length).toBeGreaterThanOrEqual(1);
    const hasCron = IMPLICIT_HEARTBEAT_ENTRIES.some(
      (e) => detectScheduleType(e.schedule) === "cron"
    );
    expect(hasCron).toBe(true);
  });

  it("all implicit entries have valid cron schedules", () => {
    for (const entry of IMPLICIT_HEARTBEAT_ENTRIES) {
      expect(detectScheduleType(entry.schedule)).toBe("cron");
    }
  });
});

describe("withImplicitEntries", () => {
  it("prepends implicit entries to parsed entries", () => {
    const parsed = parseHeartbeat("# @once\nUser entry.");
    const combined = withImplicitEntries(parsed);
    expect(combined.length).toBe(parsed.length + IMPLICIT_HEARTBEAT_ENTRIES.length);
    // Implicit entries come first
    expect(combined[0].schedule).toBe(IMPLICIT_HEARTBEAT_ENTRIES[0].schedule);
    // User entry is last
    expect(combined[combined.length - 1].payload).toBe("User entry.");
  });

  it("returns implicit entries even when parsed is empty", () => {
    const combined = withImplicitEntries([]);
    expect(combined.length).toBe(IMPLICIT_HEARTBEAT_ENTRIES.length);
  });

  it("implicit entries ensure computeNextWakeTime always returns a value", () => {
    const now = new Date("2026-03-09T20:30:00Z");
    // Empty user entries — but implicit entries guarantee a wake time
    const combined = withImplicitEntries([]);
    const result = computeNextWakeTime(combined, now);
    expect(result).not.toBeNull();
  });
});
