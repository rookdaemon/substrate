/**
 * HeartbeatParser — parse and serialise HEARTBEAT.md entries.
 *
 * Format:
 *   # <schedule> [when: <condition>]
 *   payload line 1
 *   payload line 2
 *
 *   # next entry
 *   ...
 *
 * Schedule types:
 *   @once              — fire exactly once then remove
 *   2026-03-09T20:00Z  — ISO timestamp (one-shot, fires at/after that time)
 *   * /30 * * * *      — 5-field cron (UTC, recurring) — note: no space in real cron
 *   (empty)            — no time schedule; condition-only entry
 */

export interface HeartbeatEntry {
  /** Schedule expression (ISO, cron, "@once") or empty string for condition-only. */
  schedule: string;
  /** Optional condition expression from `when:` clause. */
  condition?: string;
  /** Multi-line payload text. */
  payload: string;
}

export type ScheduleType = "once" | "iso" | "cron" | "condition-only" | "unknown";

/**
 * Determine what kind of schedule expression a string represents.
 */
export function detectScheduleType(schedule: string): ScheduleType {
  const s = schedule.trim();
  if (s === "@once") return "once";
  if (s === "") return "condition-only";
  // ISO 8601 timestamp: YYYY-MM-DDTHH:MM...
  if (/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(s)) return "iso";
  // 5-field cron: fields separated by whitespace, each field may contain digits, *, /, -, ,
  if (/^[\d*/,\-]+(\s+[\d*/,\-]+){4}$/.test(s)) return "cron";
  return "unknown";
}

/**
 * Check whether a 5-field cron expression matches the given UTC date.
 * Fields: minute hour day-of-month month day-of-week
 * Supported syntax per field: *, N, step (e.g. * /N), range (N-M), list (N,M,...)
 */
export function matchesCron(expression: string, date: Date): boolean {
  const fields = expression.trim().split(/\s+/);
  if (fields.length !== 5) return false;
  const [minuteF, hourF, domF, monthF, dowF] = fields;
  return (
    matchField(minuteF, date.getUTCMinutes(), 0, 59) &&
    matchField(hourF, date.getUTCHours(), 0, 23) &&
    matchField(domF, date.getUTCDate(), 1, 31) &&
    matchField(monthF, date.getUTCMonth() + 1, 1, 12) &&
    matchField(dowF, date.getUTCDay(), 0, 6)
  );
}

function matchField(field: string, value: number, min: number, max: number): boolean {
  if (field === "*") return true;
  const parts = field.split(",");
  return parts.some((p) => matchSingleField(p.trim(), value, min, max));
}

function matchSingleField(field: string, value: number, _min: number, max: number): boolean {
  if (field === "*") return true;

  // Step: */N or start/N or start-end/N
  if (field.includes("/")) {
    const slashIdx = field.lastIndexOf("/");
    const rangeStr = field.slice(0, slashIdx);
    const step = parseInt(field.slice(slashIdx + 1), 10);
    if (isNaN(step) || step <= 0) return false;

    let start = 0;
    let end = max;
    if (rangeStr !== "*") {
      if (rangeStr.includes("-")) {
        const [s, e] = rangeStr.split("-");
        start = parseInt(s, 10);
        end = parseInt(e, 10);
      } else {
        start = parseInt(rangeStr, 10);
        end = max;
      }
    }
    for (let i = start; i <= end; i += step) {
      if (i === value) return true;
    }
    return false;
  }

  // Range: N-M
  if (field.includes("-")) {
    const [s, e] = field.split("-");
    const start = parseInt(s, 10);
    const end = parseInt(e, 10);
    return !isNaN(start) && !isNaN(end) && value >= start && value <= end;
  }

  // Exact value
  const num = parseInt(field, 10);
  return !isNaN(num) && num === value;
}

/**
 * Returns true if both dates share the same UTC minute (used for cron dedup).
 */
export function sameUtcMinute(a: Date, b: Date): boolean {
  return (
    a.getUTCFullYear() === b.getUTCFullYear() &&
    a.getUTCMonth() === b.getUTCMonth() &&
    a.getUTCDate() === b.getUTCDate() &&
    a.getUTCHours() === b.getUTCHours() &&
    a.getUTCMinutes() === b.getUTCMinutes()
  );
}

/**
 * Produce a stable key for a HeartbeatEntry (used for last-fired / edge-trigger maps).
 */
export function entryKey(entry: HeartbeatEntry): string {
  return `${entry.schedule}|${entry.condition ?? ""}|${entry.payload.slice(0, 64)}`;
}

/**
 * Parse HEARTBEAT.md content into structured entries.
 */
export function parseHeartbeat(content: string): HeartbeatEntry[] {
  const entries: HeartbeatEntry[] = [];
  const lines = content.split("\n");

  let currentSchedule: string | null = null;
  let currentCondition: string | undefined;
  let currentPayloadLines: string[] = [];

  const flush = () => {
    if (currentSchedule !== null) {
      const payload = currentPayloadLines.join("\n").trimEnd();
      if (payload.trim()) {
        entries.push({ schedule: currentSchedule, condition: currentCondition, payload });
      }
    }
    currentSchedule = null;
    currentCondition = undefined;
    currentPayloadLines = [];
  };

  for (const line of lines) {
    if (line.startsWith("# ") || line === "#") {
      flush();
      const header = line.startsWith("# ") ? line.slice(2).trim() : "";
      const parsed = parseHeader(header);
      currentSchedule = parsed.schedule;
      currentCondition = parsed.condition;
    } else if (currentSchedule !== null) {
      // Skip leading blank lines within a payload block
      if (line.trim() === "" && currentPayloadLines.length === 0) continue;
      currentPayloadLines.push(line);
    }
  }
  flush();
  return entries;
}

function parseHeader(header: string): { schedule: string; condition?: string } {
  // "when: <condition>" at start → condition-only
  const whenOnlyMatch = header.match(/^when:\s*(.+)$/i);
  if (whenOnlyMatch) {
    return { schedule: "", condition: whenOnlyMatch[1].trim() };
  }
  // "<schedule> when: <condition>"
  const scheduleWhenMatch = header.match(/^(.+?)\s+when:\s*(.+)$/i);
  if (scheduleWhenMatch) {
    return { schedule: scheduleWhenMatch[1].trim(), condition: scheduleWhenMatch[2].trim() };
  }
  return { schedule: header };
}

/**
 * Reconstruct HEARTBEAT.md content from a list of entries.
 */
export function serialiseHeartbeat(entries: HeartbeatEntry[]): string {
  if (entries.length === 0) return "";
  return (
    entries
      .map((e) => {
        const headerBody = e.condition
          ? `${e.schedule} when: ${e.condition}`.trim()
          : e.schedule;
        return `# ${headerBody}\n${e.payload}`;
      })
      .join("\n\n") + "\n"
  );
}
