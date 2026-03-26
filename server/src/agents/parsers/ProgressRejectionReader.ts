export interface RejectionEntry {
  timestamp: string;
  target: string;
  reason: string;
}

const REJECTION_LINE_RE =
  /^\[([^\]]+)\]\s+\[SUPEREGO\]\s+Proposal for ([A-Z_]+) rejected:\s+(.+)$/;

/**
 * Parse PROGRESS.md content and return all prior proposal rejection entries.
 * Each entry includes the timestamp, the proposal target (e.g. "HABITS"), and the rejection reason.
 */
export function parseRejections(progressMarkdown: string): RejectionEntry[] {
  return progressMarkdown
    .split("\n")
    .map((line) => REJECTION_LINE_RE.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({
      timestamp: m[1],
      target: m[2],
      reason: m[3],
    }));
}

/**
 * Build a constraint block for injection into a generation prompt from prior rejections.
 * Returns an empty string when there are no rejections to surface.
 */
export function buildRejectionConstraints(rejections: RejectionEntry[]): string {
  if (rejections.length === 0) return "";

  const lines = rejections.map((r) => `- ${r.target}: ${r.reason}`).join("\n");
  return `[PRIOR REJECTION CONSTRAINTS]\nThe following proposals were previously rejected. Do not repeat these patterns:\n${lines}`;
}
