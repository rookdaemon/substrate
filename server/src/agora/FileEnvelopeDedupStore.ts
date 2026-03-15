import { rename, writeFile, readFile, unlink } from "node:fs/promises";
import { IEnvelopeDedupStore } from "./IEnvelopeDedupStore";
import type { ILogger } from "../logging";

/**
 * File-based envelope dedup store.
 *
 * Persists to `<filePath>` (a plain JSON array of strings).
 * Writes are atomic: content is written to `<filePath>.tmp` first, then
 * renamed over the target so a crash mid-write cannot corrupt the file.
 *
 * Concurrent save() calls are coalesced: while a write is in progress any
 * new calls update a "pending" snapshot; exactly one write is scheduled for
 * after the current one completes. This prevents unbounded queuing when many
 * envelopes arrive in rapid succession while ensuring the on-disk state
 * always reflects the most-recent in-memory set.
 *
 * Caps at `maxSize` IDs (oldest-first eviction, same policy as the
 * in-memory set in AgoraMessageHandler).
 */
export class FileEnvelopeDedupStore implements IEnvelopeDedupStore {
  private writing = false;
  private pending: string[] | null = null;
  private drainPromise: Promise<void> = Promise.resolve();

  constructor(
    private readonly filePath: string,
    private readonly logger: ILogger,
    private readonly maxSize: number = 500,
  ) {}

  async load(): Promise<string[]> {
    try {
      const content = await readFile(this.filePath, "utf-8");
      const parsed = JSON.parse(content);
      if (!Array.isArray(parsed) || !parsed.every((v) => typeof v === "string")) {
        this.logger.debug(`[AGORA] agora_seen.json has unexpected shape — starting with empty dedup set`);
        return [];
      }
      return parsed.slice(-this.maxSize);
    } catch (err: unknown) {
      const code = (err as NodeJS.ErrnoException).code;
      if (code !== "ENOENT") {
        // File present but unreadable / corrupt
        this.logger.debug(`[AGORA] Failed to load agora_seen.json (${code ?? String(err)}) — starting with empty dedup set`);
      }
      return [];
    }
  }

  save(ids: string[]): Promise<void> {
    if (this.writing) {
      // A write is already in flight; record the latest snapshot and return
      // the promise that resolves when the next write (for this snapshot)
      // completes.
      this.pending = ids;
      return this.drainPromise;
    }

    this.writing = true;
    this.drainPromise = this.doSave(ids).then(() => this.drainPending());
    return this.drainPromise;
  }

  private async drainPending(): Promise<void> {
    if (this.pending !== null) {
      const next = this.pending;
      this.pending = null;
      await this.doSave(next);
      await this.drainPending();
    } else {
      this.writing = false;
    }
  }

  private async doSave(ids: string[]): Promise<void> {
    const capped = ids.length > this.maxSize ? ids.slice(-this.maxSize) : ids;
    const tmpPath = `${this.filePath}.tmp`;
    try {
      await writeFile(tmpPath, JSON.stringify(capped), "utf-8");
      await rename(tmpPath, this.filePath);
    } catch (err: unknown) {
      this.logger.debug(`[AGORA] Failed to persist agora_seen.json: ${err instanceof Error ? err.message : String(err)}`);
      // Best-effort cleanup of the temp file; ignore errors.
      try { await unlink(tmpPath); } catch { /* ignore */ }
    }
  }
}
