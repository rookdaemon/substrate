import { promises as fs } from "fs";
import type { IClock } from "../substrate/abstractions/IClock";

export interface PeerRateLimitRecord {
  identity: string;
  rateLimitUntil: string; // ISO date string
  notedAt: string; // ISO date string
}

interface StoredState {
  peers: PeerRateLimitRecord[];
}

/**
 * Tracks and persists per-peer rate limit status.
 *
 * When a peer signals it is rate-limited (via a structured peerStatus field in its
 * Agora message payload), that information is recorded here so the agent can be
 * notified on the next session start.
 */
export class PeerRateLimitStore {
  private peers: Map<string, PeerRateLimitRecord> = new Map();

  constructor(
    private readonly filePath: string,
    private readonly clock: IClock,
  ) {}

  /**
   * Record or update a peer's rate limit status.
   * A future date clears any previously recorded limit for the same identity.
   */
  record(identity: string, rateLimitUntil: Date): void {
    this.peers.set(identity, {
      identity,
      rateLimitUntil: rateLimitUntil.toISOString(),
      notedAt: this.clock.now().toISOString(),
    });
  }

  /**
   * Return all peers whose rate limit has not yet expired.
   */
  getActive(): PeerRateLimitRecord[] {
    const now = this.clock.now().getTime();
    return Array.from(this.peers.values()).filter(
      (r) => new Date(r.rateLimitUntil).getTime() > now,
    );
  }

  async load(): Promise<void> {
    try {
      const raw = await fs.readFile(this.filePath, "utf-8");
      const state = JSON.parse(raw) as StoredState;
      this.peers = new Map(state.peers.map((r) => [r.identity, r]));
    } catch {
      // File absent or corrupt — start fresh
    }
  }

  async save(): Promise<void> {
    const state: StoredState = { peers: Array.from(this.peers.values()) };
    await fs.writeFile(this.filePath, JSON.stringify(state, null, 2));
  }
}
