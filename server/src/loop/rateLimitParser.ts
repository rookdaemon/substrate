/**
 * Parses rate limit reset time from Claude SDK output.
 * Matches two patterns:
 *   - "resets 7pm (UTC)" — same-day or next-day reset
 *   - "resets Feb 14, 10am (UTC)" — specific date reset
 * Returns the parsed UTC Date, or null if not a rate limit message.
 */

const MONTH_MAP: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5,
  jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};

function parseHour(hourStr: string, ampm: string): number {
  let hour = parseInt(hourStr, 10);
  const ap = ampm.toLowerCase();
  if (ap === "am" && hour === 12) hour = 0;
  else if (ap === "pm" && hour !== 12) hour += 12;
  return hour;
}

export function parseRateLimitReset(
  output: string | undefined,
  now: Date,
): Date | null {
  if (!output) return null;

  // Pattern 1: "resets Feb 14, 10am (UTC)" — with date
  const dateMatch = output.match(
    /resets\s+([A-Za-z]{3})\s+(\d{1,2}),?\s+(\d{1,2})(am|pm)\s*\(UTC\)/i,
  );
  if (dateMatch) {
    const monthIdx = MONTH_MAP[dateMatch[1].toLowerCase()];
    if (monthIdx === undefined) return null;
    const day = parseInt(dateMatch[2], 10);
    const hour = parseHour(dateMatch[3], dateMatch[4]);

    const reset = new Date(now);
    reset.setUTCMonth(monthIdx, day);
    reset.setUTCHours(hour, 0, 0, 0);

    // If the resulting date is before now, assume next year
    if (reset.getTime() <= now.getTime()) {
      reset.setUTCFullYear(reset.getUTCFullYear() + 1);
    }

    return reset;
  }

  // Pattern 2: "resets 7pm (UTC)" — time only
  const timeMatch = output.match(/resets\s+(\d{1,2})(am|pm)\s*\(UTC\)/i);
  if (timeMatch) {
    const hour = parseHour(timeMatch[1], timeMatch[2]);

    const reset = new Date(now);
    reset.setUTCMinutes(0, 0, 0);
    reset.setUTCHours(hour);

    if (reset.getTime() <= now.getTime()) {
      reset.setUTCDate(reset.getUTCDate() + 1);
    }

    return reset;
  }

  return null;
}
