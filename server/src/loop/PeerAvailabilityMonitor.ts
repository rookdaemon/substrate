import type { IMessageInjector } from "./IMessageInjector";
import type { ILogger } from "../logging";

export interface PeerConfig {
  name: string;
  port: number;
}

export interface PeerStatus {
  name: string;
  state: string;
  rateLimitUntil: string | null;
  online: boolean;
}

type FetchFn = (url: string, opts?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/**
 * Monitors peer substrate availability by polling their /api/loop/status endpoints.
 *
 * Trigger points:
 * 1. On startup via scanAll() — injects [PEER STATUS] for any rate-limited peer
 * 2. On first failed contact via onContactFailed(name) — injects current status
 *
 * Injection is deduplicated: the same (peer, rateLimitUntil) pair is never injected twice.
 * A new injection fires if rateLimitUntil changes (peer hit a new rate limit after recovery).
 */
export class PeerAvailabilityMonitor {
  /** Maps peer name → last injected rateLimitUntil value (null = ACTIVE was last injected) */
  private readonly lastInjected = new Map<string, string | null>();

  constructor(
    private readonly peers: PeerConfig[],
    private readonly injector: IMessageInjector,
    private readonly logger: ILogger,
    private readonly fetchFn: FetchFn = defaultFetch,
  ) {}

  /**
   * Scan all configured peers. Called once on startup.
   * Injects [PEER STATUS] for any peer that is currently rate-limited.
   */
  async scanAll(): Promise<void> {
    for (const peer of this.peers) {
      try {
        const status = await this.readPeerStatus(peer.port, peer.name);
        if (status.rateLimitUntil !== null) {
          this.maybeInject(status);
        }
      } catch (err) {
        this.logger.debug(
          `[PEER-MONITOR] Warning: could not reach ${peer.name} on port ${peer.port} during startup scan: ${err instanceof Error ? err.message : String(err)}`
        );
      }
    }
  }

  /**
   * Called when a contact attempt to a named peer fails.
   * Looks up the peer's port, polls its status, and injects if rate-limited.
   */
  async onContactFailed(peerName: string): Promise<void> {
    const peer = this.peers.find((p) => p.name === peerName);
    if (!peer) {
      this.logger.debug(`[PEER-MONITOR] onContactFailed: unknown peer "${peerName}" — no ports configured`);
      return;
    }
    try {
      const status = await this.readPeerStatus(peer.port, peer.name);
      this.maybeInject(status);
    } catch (err) {
      this.logger.debug(
        `[PEER-MONITOR] Warning: could not reach ${peerName} on port ${peer.port} after failed contact: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Read peer status from its /api/loop/status endpoint.
   * Returns an offline PeerStatus if the connection is refused or the request fails.
   */
  async readPeerStatus(port: number, fallbackName: string): Promise<PeerStatus> {
    const url = `http://localhost:${port}/api/loop/status`;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        return { name: fallbackName, state: "UNKNOWN", rateLimitUntil: null, online: false };
      }
      const body = await res.json() as Record<string, unknown>;
      const name = (body.meta as Record<string, unknown> | undefined)?.name as string | undefined ?? fallbackName;
      const state = typeof body.state === "string" ? body.state : "UNKNOWN";
      const rateLimitUntil = typeof body.rateLimitUntil === "string" ? body.rateLimitUntil : null;
      return { name, state, rateLimitUntil, online: true };
    } catch {
      return { name: fallbackName, state: "OFFLINE", rateLimitUntil: null, online: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  /**
   * Inject a [PEER STATUS] note if this event hasn't already been reported.
   * Deduplication key: (peer name, rateLimitUntil).
   */
  private maybeInject(status: PeerStatus): void {
    const key = status.name;
    const last = this.lastInjected.get(key);

    // Skip if same rateLimitUntil was already injected for this peer
    if (last !== undefined && last === status.rateLimitUntil) {
      return;
    }

    this.lastInjected.set(key, status.rateLimitUntil);

    let line: string;
    if (!status.online) {
      // Offline — log warning but don't inject (per acceptance criteria)
      this.logger.debug(`[PEER-MONITOR] ${status.name} is offline (connection refused or timeout)`);
      return;
    } else if (status.rateLimitUntil !== null) {
      line = `[PEER STATUS] ${status.name}: RATE_LIMITED until ${status.rateLimitUntil}`;
    } else {
      line = `[PEER STATUS] ${status.name}: ACTIVE`;
    }

    this.logger.debug(`[PEER-MONITOR] Injecting: ${line}`);
    this.injector.injectMessage(line);
  }
}

async function defaultFetch(
  url: string,
  opts?: { signal?: AbortSignal }
): Promise<{ ok: boolean; json(): Promise<unknown> }> {
  return fetch(url, opts) as Promise<{ ok: boolean; json(): Promise<unknown> }>;
}
