import {
  parseHeartbeat,
  serialiseHeartbeat,
  detectScheduleType,
  matchesCron,
  sameUtcMinute,
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
