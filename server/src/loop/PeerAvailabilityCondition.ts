import type { IConditionEvaluator } from "./IConditionEvaluator";
import type { ILogger } from "../logging";

type FetchFn = (
  url: string,
  opts?: { signal?: AbortSignal }
) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

export interface PeerAvailabilityConditionConfig {
  peerId: string;
  apiStatusUrl: string;
}

/**
 * PeerAvailabilityCondition — fires when a peer transitions from unavailable to available.
 *
 * Matches condition: `peer:<peerId>.available`
 *
 * A peer is considered available when:
 *   - The /api/loop/status endpoint responds successfully (online), AND
 *   - The peer has no active rate limit (rateLimitUntil is null or in the past)
 *
 * This evaluator maintains internal state to detect the offline→online edge transition.
 * HeartbeatScheduler additionally tracks its own edge (false→true from evaluate's POV),
 * so the combination correctly fires exactly once per recovery event.
 */
export class PeerAvailabilityCondition implements IConditionEvaluator {
  static readonly PREFIX = "peer:";

  /** Tracks whether each peer was available on the last evaluation. */
  private readonly lastAvailable = new Map<string, boolean>();

  constructor(
    private readonly peers: PeerAvailabilityConditionConfig[],
    private readonly logger: ILogger,
    private readonly fetchFn: FetchFn = defaultFetch
  ) {}

  async evaluate(condition: string): Promise<boolean> {
    // Expected format: "peer:<peerId>.available"
    const match = condition.match(/^peer:(.+)\.available$/);
    if (!match) {
      this.logger.debug(`[HEARTBEAT] PeerAvailabilityCondition: unrecognised condition "${condition}"`);
      return false;
    }
    const peerId = match[1];
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) {
      this.logger.debug(`[HEARTBEAT] PeerAvailabilityCondition: unknown peer "${peerId}"`);
      return false;
    }

    const available = await this.isAvailable(peer);
    const wasAvailable = this.lastAvailable.get(peerId) ?? false;
    this.lastAvailable.set(peerId, available);

    // Edge trigger: return true only on false→true transition
    return !wasAvailable && available;
  }

  private async isAvailable(peer: PeerAvailabilityConditionConfig): Promise<boolean> {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await this.fetchFn(peer.apiStatusUrl, { signal: controller.signal });
      if (!res.ok) return false;
      const body = (await res.json()) as Record<string, unknown>;
      const rateLimitUntil =
        typeof body.rateLimitUntil === "string" ? body.rateLimitUntil : null;
      if (rateLimitUntil) {
        const rateLimitMs = Date.parse(rateLimitUntil);
        if (Number.isFinite(rateLimitMs) && rateLimitMs > Date.now()) {
          return false; // still rate-limited
        }
      }
      return true; // online and not rate-limited
    } catch {
      return false;
    } finally {
      clearTimeout(timeout);
    }
  }
}

async function defaultFetch(
  url: string,
  opts?: { signal?: AbortSignal }
): Promise<{ ok: boolean; json(): Promise<unknown> }> {
  return fetch(url, opts) as Promise<{ ok: boolean; json(): Promise<unknown> }>;
}
