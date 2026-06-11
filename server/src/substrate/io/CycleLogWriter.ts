import * as path from "path";
import { IFileSystem } from "../abstractions/IFileSystem";
import { IClock } from "../abstractions/IClock";
import { ICycleLogWriter } from "./ICycleLogWriter";

/** Default maximum size for cycle_log.md before rotation (10 MB). */
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/** Default number of rotated log files to keep alongside the active log. */
const DEFAULT_KEEP_FILES = 3;

export interface CycleLogRotationOptions {
  /** Maximum file size in bytes before rotation. Default: 10 MB. */
  maxSizeBytes?: number;
  /** Number of rotated files to keep. Oldest files are deleted when this limit is exceeded. Default: 3. */
  keepFiles?: number;
}

/**
 * Appends cycle-execution output (EGO narration, task summaries) to
 * `<substratePath>/cycle_log.md` with the format:
 *
 *   [YYYY-MM-DDTHH:mm:ssZ] [ROLE] <text>
 *
 * This file is append-only and never compacted, so CONVERSATION.md stays
 * clean (D-01 fix).
 *
 * **Rotation**: When the file would exceed `maxSizeBytes`, the current log is
 * renamed to `cycle_log.<ISO-timestamp>.md` before the new entry is written.
 * Old rotated files are pruned to keep at most `keepFiles` archives.
 * Rotation errors are silently swallowed — write failures must never block the cycle.
 */
export class CycleLogWriter implements ICycleLogWriter {
  private readonly maxSizeBytes: number;
  private readonly keepFiles: number;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly substratePath: string,
    private readonly fileName: string = "cycle_log.md",
    options?: CycleLogRotationOptions,
  ) {
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.keepFiles = options?.keepFiles ?? DEFAULT_KEEP_FILES;
  }

  async write(role: string, text: string): Promise<void> {
    const timestamp = this.clock.now().toISOString();
    const entry = `[${timestamp}] [${role}] ${text}\n`;
    const filePath = path.join(this.substratePath, this.fileName);

    // Rotate before appending if the file would exceed the size cap.
    // Errors are swallowed: rotation is best-effort; the write itself must succeed.
    try {
      await this.rotateIfNeeded(filePath, entry.length);
    } catch {
      // Rotation error — continue; the cycle must not be blocked.
    }

    await this.fs.appendFile(filePath, entry);
  }

  /**
   * Rename the active log to a timestamped archive if appending `pendingBytes`
   * would push the file over `maxSizeBytes`.
   */
  private async rotateIfNeeded(filePath: string, pendingBytes: number): Promise<void> {
    let currentSize = 0;
    try {
      const stat = await this.fs.stat(filePath);
      currentSize = stat.size;
    } catch {
      // File doesn't exist yet — no rotation needed.
      return;
    }

    if (currentSize + pendingBytes <= this.maxSizeBytes) return;

    // Build archive filename: cycle_log.2026-06-11T09-21-37.md
    const now = this.clock.now();
    const stamp = now.toISOString()
      .replace(/\.\d{3}Z$/, "Z") // drop milliseconds
      .replace(/:/g, "-");       // colons are invalid in filenames on Windows; also cleaner
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath, ".md");
    const archivePath = path.join(dir, `${baseName}.${stamp}.md`);

    await this.fs.rename(filePath, archivePath);

    // Prune oldest archives so we don't accumulate more than keepFiles.
    await this.pruneOldArchives(dir, baseName);
  }

  /**
   * Remove the oldest rotated files from `dir` so that at most `keepFiles` archives remain.
   * Errors are silently swallowed.
   */
  private async pruneOldArchives(dir: string, baseName: string): Promise<void> {
    try {
      const entries = await this.fs.readdir(dir);
      // Match `cycle_log.<anything>.md` but not `cycle_log.md` itself.
      const archivePattern = new RegExp(`^${baseName}\\..+\\.md$`);
      const archives = entries.filter(e => archivePattern.test(e)).sort();
      // Archives are ISO-timestamp-named → lexicographic sort is chronological order.
      // Remove oldest first until we're within the limit.
      const excess = archives.length - this.keepFiles;
      for (let i = 0; i < excess; i++) {
        try {
          await this.fs.unlink(path.join(dir, archives[i]));
        } catch {
          // Individual unlink errors are non-fatal.
        }
      }
    } catch {
      // Directory read errors are non-fatal.
    }
  }
}
