import { IFileSystem } from "../substrate/abstractions/IFileSystem";
import type { ILogger } from "../logging";

/**
 * Persisted Agora state, stored in `.agora_state.json` alongside the agent's data directory.
 *
 * `lastSeen` maps each peer's public key to the epoch-millisecond timestamp of the last
 * successfully processed message from that peer. Used as the anchor for wake polling on
 * startup so the relay can replay messages missed during hibernation.
 */
export interface AgoraState {
  lastSeen: Record<string, number>; // peerPubkey → epoch ms of last processed message
}

/**
 * AgoraStateStore persists `lastSeen[peerPubkey]` across substrate restarts.
 *
 * Responsibilities:
 * - Load and save `.agora_state.json` via the injected IFileSystem
 * - Update `lastSeen` after each successfully processed inbound message
 * - Provide the minimum `lastSeen` anchor used by AgoraWakePoller on startup
 */
export class AgoraStateStore {
  constructor(
    private readonly statePath: string,
    private readonly fs: IFileSystem,
    private readonly logger: ILogger | null = null,
  ) {}

  /** Load the current state from disk, returning a default if the file is absent or invalid. */
  async load(): Promise<AgoraState> {
    try {
      const content = await this.fs.readFile(this.statePath);
      const parsed = JSON.parse(content) as Partial<AgoraState>;
      return {
        lastSeen: (parsed.lastSeen && typeof parsed.lastSeen === "object") ? parsed.lastSeen : {},
      };
    } catch {
      return { lastSeen: {} };
    }
  }

  /** Overwrite the entire state on disk. */
  async save(state: AgoraState): Promise<void> {
    await this.fs.writeFile(this.statePath, JSON.stringify(state, null, 2));
  }

  /**
   * Record that we just processed a message from `peerPubkey`.
   * Only writes to disk when `timestampMs` is newer than the stored value — prevents
   * going backwards if envelopes are delivered out of order.
   */
  async updateLastSeen(peerPubkey: string, timestampMs: number): Promise<void> {
    try {
      const state = await this.load();
      const current = state.lastSeen[peerPubkey] ?? 0;
      if (timestampMs > current) {
        state.lastSeen[peerPubkey] = timestampMs;
        await this.save(state);
        this.logger?.debug(`[AGORA] AgoraStateStore: updated lastSeen for ${peerPubkey.slice(-8)} to ${new Date(timestampMs).toISOString()}`);
      }
    } catch (err) {
      this.logger?.debug(`[AGORA] AgoraStateStore: failed to update lastSeen — ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  /** Return the epoch-ms timestamp of the last processed message from `peerPubkey`, or undefined. */
  async getLastSeen(peerPubkey: string): Promise<number | undefined> {
    const state = await this.load();
    return state.lastSeen[peerPubkey];
  }

  /** Return all stored lastSeen entries. */
  async getLastSeenAll(): Promise<Record<string, number>> {
    const state = await this.load();
    return state.lastSeen;
  }
}
