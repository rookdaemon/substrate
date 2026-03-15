import { IFileSystem } from "../../substrate/abstractions/IFileSystem";
import { ILogger } from "../../logging";

/**
 * Trims a single substrate file (CONVERSATION.md or PROGRESS.md) if it
 * exceeds the threshold. Removes the oldest timestamped entries from the
 * raw tail until the line count reaches floor(threshold * targetRatio).
 * Structural blocks (markdown headers, summaries) are always preserved.
 */
async function trimFile(
  filePath: string,
  threshold: number,
  targetRatio: number,
  fs: IFileSystem,
  logger: ILogger,
): Promise<void> {
  let content: string;
  try {
    content = await fs.readFile(filePath);
  } catch {
    return; // File doesn't exist — no action
  }

  const lines = content.split("\n");
  const before = lines.length;

  if (before <= threshold) {
    return; // Within threshold — no action
  }

  const target = Math.floor(threshold * targetRatio);

  // Find the boundary between the structural head and the raw recent tail.
  // Raw entries are timestamped lines written by AppendOnlyWriter:
  //   [2026-03-01T12:00:00.000Z] <entry content>
  // Everything before the first such line is a structural block
  // (main header, session summaries, section headers) and is preserved.
  const rawTailStart = lines.findIndex((line) => line.startsWith("["));
  if (rawTailStart === -1) {
    // No raw entries found — nothing to trim
    return;
  }

  const structuralHead = lines.slice(0, rawTailStart);
  const rawTail = lines.slice(rawTailStart);

  // Remove the oldest lines from the beginning of the raw tail.
  const toRemove = Math.min(before - target, rawTail.length);
  if (toRemove <= 0) {
    return;
  }

  const trimmedTail = rawTail.slice(toRemove);
  const newLines = [...structuralHead, ...trimmedTail];
  const after = newLines.length;

  await fs.writeFile(filePath, newLines.join("\n"));
  logger.debug(`[INS] Rate-limit trim: ${before} → ${after} lines`);
}

/**
 * Deterministic trim for CONVERSATION.md and PROGRESS.md during rate-limit
 * sleep. Runs without any model calls.
 *
 * - CONVERSATION.md: trims oldest raw entries to floor(threshold * 0.75)
 * - PROGRESS.md: trims oldest raw entries to floor(threshold * 0.85)
 *   (higher ratio preserves more history)
 *
 * Structural blocks — markdown headers, session summaries, and any
 * non-timestamped content — are preserved unchanged in both files.
 *
 * This is a size cap only. Full LLM-based compaction still runs on the next
 * non-rate-limited cycle if a file remains over threshold.
 *
 * @param conversationPath - Absolute path to CONVERSATION.md
 * @param threshold - Line count threshold (same as INS compaction threshold)
 * @param fs - File system abstraction
 * @param logger - Logger
 * @param progressPath - Optional absolute path to PROGRESS.md
 */
export async function insMaintenanceTrim(
  conversationPath: string,
  threshold: number,
  fs: IFileSystem,
  logger: ILogger,
  progressPath?: string,
): Promise<void> {
  await trimFile(conversationPath, threshold, 0.75, fs, logger);
  if (progressPath !== undefined) {
    await trimFile(progressPath, threshold, 0.85, fs, logger);
  }
}
