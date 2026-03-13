import type { IMessageInjector } from "./IMessageInjector";
import type { ILogger } from "../logging";

export interface PeerConfig {
  peerId: string;
  apiStatusUrl: string;
}

export interface PeerStatus {
  peerId: string;
  state: string;
  rateLimitUntil: string | null;
  online: boolean;
}

type FetchFn = (url: string, opts?: { signal?: AbortSignal }) => Promise<{ ok: boolean; json(): Promise<unknown> }>;

/** Minimal file system interface needed for state persistence. */
export interface IPeerMonitorFileSystem {
  readFile(path: string): Promise<string>;
  writeFile(path: string, content: string): Promise<void>;
}

/**
 * Monitors peer substrate availability by polling each peer's API status URL.
 *
 * On each scan, this class computes active peer rate limits and injects
 * `rateLimitedUntil[peerId]=<iso timestamp>` updates for new/changed entries only.
 *
 * When `statePath` and `fileSystem` are provided, `lastInjectedActiveRateLimit`
 * is persisted to disk so redundant re-injections are suppressed across restarts.
 */
export class PeerAvailabilityMonitor {
  /** Maps peerId -> last injected active rateLimitUntil value. */
  private readonly lastInjectedActiveRateLimit = new Map<string, string>();

  constructor(
    private readonly peers: PeerConfig[],
    private readonly injector: IMessageInjector,
    private readonly logger: ILogger,
    private readonly fetchFn: FetchFn = defaultFetch,
    private readonly fileSystem?: IPeerMonitorFileSystem,
    private readonly statePath?: string,
  ) { }

  /**
   * Load persisted rate-limit state from disk.
   * Call once after construction (before the first scan) when `statePath` is configured.
   */
  async loadState(now: Date = new Date()): Promise<void> {
    if (!this.fileSystem || !this.statePath) return;
    try {
      const raw = await this.fileSystem.readFile(this.statePath);
      const parsed = JSON.parse(raw) as Record<string, unknown>;
      const nowMs = now.getTime();
      for (const [peerId, value] of Object.entries(parsed)) {
        if (typeof value !== "string") continue;
        const expiryMs = Date.parse(value);
        if (!Number.isFinite(expiryMs) || expiryMs <= nowMs) continue;
        // Only restore still-active rate limits
        this.lastInjectedActiveRateLimit.set(peerId, value);
      }
      this.logger.debug(`[PEER-MONITOR] Loaded ${this.lastInjectedActiveRateLimit.size} active rate limit(s) from state`);
    } catch {
      // No state file yet — fresh start
    }
  }

  /**
   * Scan all configured peers and inject active rate-limit updates.
   *
   * Timing contract: completes in max(individual timeouts), not sum(individual timeouts).
   * All peer fetches run concurrently via Promise.all() — each peer targets a different
   * endpoint, so there is no single upstream to protect with a concurrency limit.
   */
  async scanAll(now: Date = new Date()): Promise<void> {
    const nowMs = now.getTime();
    const activeThisScan = new Map<string, string>();

    const results = await Promise.all(
      this.peers.map(async (peer) => {
        try {
          return await this.readPeerStatus(peer);
        } catch (err) {
          this.logger.debug(
            `[PEER-MONITOR] Warning: could not read status for ${peer.peerId} at ${peer.apiStatusUrl}: ${err instanceof Error ? err.message : String(err)}`
          );
          return null;
        }
      })
    );

    for (const status of results) {
      if (!status || !status.online || status.rateLimitUntil === null) {
        continue;
      }

      const rateLimitUntilMs = Date.parse(status.rateLimitUntil);
      if (!Number.isFinite(rateLimitUntilMs) || rateLimitUntilMs <= nowMs) {
        continue;
      }

      activeThisScan.set(status.peerId, status.rateLimitUntil);
    }

    let changed = false;
    for (const [peerId, rateLimitUntil] of activeThisScan) {
      const last = this.lastInjectedActiveRateLimit.get(peerId);
      if (last === rateLimitUntil) {
        continue;
      }
      this.lastInjectedActiveRateLimit.set(peerId, rateLimitUntil);
      this.injectRateLimit(peerId, rateLimitUntil);
      changed = true;
    }

    // Cleanup recovered/expired peers so a future rate-limit is reinjected.
    for (const peerId of Array.from(this.lastInjectedActiveRateLimit.keys())) {
      if (!activeThisScan.has(peerId)) {
        this.lastInjectedActiveRateLimit.delete(peerId);
        changed = true;
      }
    }

    if (changed) {
      await this.persistState();
    }
  }

  /**
   * Called when a contact attempt to a named peer fails.
   * Looks up the peer's port, polls its status, and injects if rate-limited.
   */
  async onContactFailed(peerId: string, now: Date = new Date()): Promise<void> {
    const peer = this.peers.find((p) => p.peerId === peerId);
    if (!peer) {
      this.logger.debug(`[PEER-MONITOR] onContactFailed: unknown peer "${peerId}"`);
      return;
    }

    try {
      const status = await this.readPeerStatus(peer);
      if (!status.online || status.rateLimitUntil === null) {
        return;
      }

      const nowMs = now.getTime();
      const rateLimitUntilMs = Date.parse(status.rateLimitUntil);
      if (!Number.isFinite(rateLimitUntilMs) || rateLimitUntilMs <= nowMs) {
        return;
      }

      const last = this.lastInjectedActiveRateLimit.get(status.peerId);
      if (last === status.rateLimitUntil) {
        return;
      }
      this.lastInjectedActiveRateLimit.set(status.peerId, status.rateLimitUntil);
      this.injectRateLimit(status.peerId, status.rateLimitUntil);
      await this.persistState();
    } catch (err) {
      this.logger.debug(
        `[PEER-MONITOR] Warning: could not read status for ${peerId} at ${peer.apiStatusUrl} after failed contact: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Read peer status from its /api/loop/status endpoint.
   * Returns an offline PeerStatus if the connection is refused or the request fails.
   */
  async readPeerStatus(peer: PeerConfig): Promise<PeerStatus> {
    const url = peer.apiStatusUrl;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    try {
      const res = await this.fetchFn(url, { signal: controller.signal });
      if (!res.ok) {
        return { peerId: peer.peerId, state: "UNKNOWN", rateLimitUntil: null, online: false };
      }
      const body = await res.json() as Record<string, unknown>;
      const state = typeof body.state === "string" ? body.state : "UNKNOWN";
      const rateLimitUntil = typeof body.rateLimitUntil === "string" ? body.rateLimitUntil : null;
      return { peerId: peer.peerId, state, rateLimitUntil, online: true };
    } catch {
      return { peerId: peer.peerId, state: "OFFLINE", rateLimitUntil: null, online: false };
    } finally {
      clearTimeout(timeout);
    }
  }

  private injectRateLimit(peerId: string, rateLimitUntil: string): void {
    const line = `[PEER RATE LIMIT] rateLimitedUntil[${peerId}]=${rateLimitUntil}`;
    this.logger.debug(`[PEER-MONITOR] Injecting: ${line}`);
    this.injector.injectMessage(line);
  }

  private async persistState(): Promise<void> {
    if (!this.fileSystem || !this.statePath) return;
    try {
      const obj: Record<string, string> = {};
      for (const [peerId, value] of this.lastInjectedActiveRateLimit) {
        obj[peerId] = value;
      }
      await this.fileSystem.writeFile(this.statePath, JSON.stringify(obj));
    } catch (err) {
      this.logger.debug(
        `[PEER-MONITOR] Failed to persist state: ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }
}

async function defaultFetch(
  url: string,
  opts?: { signal?: AbortSignal }
): Promise<{ ok: boolean; json(): Promise<unknown> }> {
  return fetch(url, opts) as Promise<{ ok: boolean; json(): Promise<unknown> }>;
}
