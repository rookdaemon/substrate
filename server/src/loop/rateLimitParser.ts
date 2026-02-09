/**
 * Parses rate limit reset time from Claude SDK output.
 * Matches patterns like "resets 7pm (UTC)", "resets 3am (UTC)", "resets 12pm (UTC)".
 * Returns the next occurrence of that UTC hour, or null if not a rate limit message.
 */
export function parseRateLimitReset(
  output: string | undefined,
  now: Date,
): Date | null {
  if (!output) return null;

  const match = output.match(/resets\s+(\d{1,2})(am|pm)\s*\(UTC\)/i);
  if (!match) return null;

  let hour = parseInt(match[1], 10);
  const ampm = match[2].toLowerCase();

  if (ampm === "am" && hour === 12) {
    hour = 0;
  } else if (ampm === "pm" && hour !== 12) {
    hour += 12;
  }

  const reset = new Date(now);
  reset.setUTCMinutes(0, 0, 0);
  reset.setUTCHours(hour);

  // If the reset time is in the past or now, it means next day
  if (reset.getTime() <= now.getTime()) {
    reset.setUTCDate(reset.getUTCDate() + 1);
  }

  return reset;
}
