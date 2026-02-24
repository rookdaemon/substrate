/**
 * Returns a short preview of a string for use in debug log messages.
 * If the string is longer than maxChars, it is truncated and '...' is appended.
 */
export function msgPreview(s: string, maxChars = 80): string {
  return s.length <= maxChars ? s : s.slice(0, maxChars) + "...";
}
