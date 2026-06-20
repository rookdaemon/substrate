import * as path from "path";
import { IFileSystem } from "../abstractions/IFileSystem";
import { IClock } from "../abstractions/IClock";
import { ICycleLogWriter } from "./ICycleLogWriter";

/** Default maximum size for cycle_log.md before rotation (10 MB). */
const DEFAULT_MAX_SIZE_BYTES = 10 * 1024 * 1024;

/** Default number of rotated log files to keep alongside the active log. */
const DEFAULT_KEEP_FILES = 3;

/** Default low-disk threshold: skip write when fewer than 100 MB free. */
const DEFAULT_LOW_DISK_BYTES = 100 * 1024 * 1024;

export interface CycleLogRotationOptions {
  /** Maximum file size in bytes before rotation. Default: 10 MB. */
  maxSizeBytes?: number;
  /** Number of rotated files to keep. Oldest files are deleted when this limit is exceeded. Default: 3. */
  keepFiles?: number;
  /**
   * Optional callback that returns available bytes on the filesystem containing `dirPath`.
   * When provided, writes are skipped if free space is below `lowDiskBytesThreshold`.
   * If omitted, no disk-space pre-check is performed.
   */
  diskSpaceChecker?: (dirPath: string) => Promise<number>;
  /**
   * Minimum free bytes required before writing a log entry. Default: 100 MB.
   * Only relevant when `diskSpaceChecker` is provided.
   */
  lowDiskBytesThreshold?: number;
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
 *
 * **Disk-space guard**: When `diskSpaceChecker` is provided, the write is
 * silently skipped if free space is below `lowDiskBytesThreshold` (default
 * 100 MB). ENOSPC errors from `appendFile` are also caught; on ENOSPC we
 * attempt an emergency rotation to free space and retry once.
 */
export class CycleLogWriter implements ICycleLogWriter {
  private readonly maxSizeBytes: number;
  private readonly keepFiles: number;
  private readonly diskSpaceChecker?: (dirPath: string) => Promise<number>;
  private readonly lowDiskBytesThreshold: number;

  constructor(
    private readonly fs: IFileSystem,
    private readonly clock: IClock,
    private readonly substratePath: string,
    private readonly fileName: string = "cycle_log.md",
    options?: CycleLogRotationOptions,
  ) {
    this.maxSizeBytes = options?.maxSizeBytes ?? DEFAULT_MAX_SIZE_BYTES;
    this.keepFiles = options?.keepFiles ?? DEFAULT_KEEP_FILES;
    this.diskSpaceChecker = options?.diskSpaceChecker;
    this.lowDiskBytesThreshold = options?.lowDiskBytesThreshold ?? DEFAULT_LOW_DISK_BYTES;
  }

  async write(role: string, text: string): Promise<void> {
    const timestamp = this.clock.now().toISOString();
    const entry = `[${timestamp}] [${role}] ${text}\n`;
    const filePath = path.join(this.substratePath, this.fileName);
    const dir = path.dirname(filePath);

    // Pre-write disk-space check: silently skip the write if we're low on disk.
    if (this.diskSpaceChecker) {
      try {
        const freeBytes = await this.diskSpaceChecker(dir);
        if (freeBytes < this.lowDiskBytesThreshold) {
          // Low disk — skip this log entry rather than risking ENOSPC.
          return;
        }
      } catch {
        // diskSpaceChecker failed — continue; the write attempt may still succeed.
      }
    }

    // Rotate before appending if the file would exceed the size cap.
    // Errors are swallowed: rotation is best-effort; the write itself must succeed.
    try {
      await this.rotateIfNeeded(filePath, entry.length);
    } catch {
      // Rotation error — continue; the cycle must not be blocked.
    }

    try {
      await this.fs.appendFile(filePath, entry);
    } catch (err) {
      if (isEnoSpc(err)) {
        // Out of disk space: attempt emergency rotation to free up the current log,
        // then retry the write once. If that also fails, swallow the error.
        try {
          await this.forceRotate(filePath);
          await this.fs.appendFile(filePath, entry);
        } catch {
          // Emergency rotation + retry failed — give up silently; cycle must not block.
        }
        return;
      }
      // Non-ENOSPC appendFile errors are re-thrown; callers should not block on them.
      // (Swallowing here would hide real bugs like permission errors on a writeable dir.)
      throw err;
    }
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

    await this.forceRotate(filePath);
  }

  /** Unconditionally rotate the active log to a timestamped archive. */
  private async forceRotate(filePath: string): Promise<void> {
    // Build archive filename: cycle_log.2026-06-11T09-21-37Z.md
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

function isEnoSpc(err: unknown): boolean {
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === "ENOSPC";
  }
  return false;
}
