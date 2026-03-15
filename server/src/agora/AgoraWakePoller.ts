import type { IClock } from "../substrate/abstractions/IClock";
import type { ILogger } from "../logging";
import { AgoraStateStore } from "./AgoraStateStore";
import { AgoraMessageHandler } from "./AgoraMessageHandler";
import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

/** Maximum gap to look back when polling the relay on startup (7 days). */
export const MAX_LOOKBACK_MS = 7 * 24 * 60 * 60 * 1000;

/**
 * Minimal HTTP fetch interface so tests can inject a mock without spawning real network calls.
 */
export interface IFetcher {
  fetch(url: string): Promise<{ ok: boolean; status: number; json(): Promise<unknown> }>;
}

/**
 * Shape of the relay replay response.
 * The relay `/api/relay/replay` endpoint returns a JSON object with a `messages` array.
 */
interface ReplayResponse {
  messages: Envelope[];
}

/**
 * AgoraWakePoller — substrate-side wake polling for missed Agora messages.
 *
 * On startup (after hibernation or process restart) the substrate may have missed
 * messages that the relay queued while it was down. This poller:
 *  1. Reads `lastSeen[peerPubkey]` from `AgoraStateStore` (anchored per sender).
 *  2. Computes an effective `since` timestamp: `max(minLastSeen, now − 7 days)`.
 *  3. Calls `GET <relayRestUrl>/api/relay/replay?since=<ms>&peer=<selfPubkey>` to fetch
 *     messages queued for this substrate's public key.
 *  4. Injects each replayed envelope into `AgoraMessageHandler.processEnvelope`.
 *     Existing envelope-ID and content dedup in AgoraMessageHandler prevent double-processing.
 *  5. Degrades gracefully if the relay endpoint is unavailable (logs and continues).
 *
 * The `verifyFn` parameter accepts the `verifyEnvelope` export from `@rookdaemon/agora` so
 * replayed envelopes are authenticated before being fed to the message handler.
 */
export class AgoraWakePoller {
  private readonly maxLookbackMs: number;

  constructor(
    private readonly stateStore: AgoraStateStore,
    private readonly relayRestUrl: string,
    private readonly selfPubkey: string,
    private readonly messageHandler: AgoraMessageHandler,
    private readonly verifyFn: (e: Envelope) => { valid: boolean; reason?: string },
    private readonly logger: ILogger,
    private readonly clock: IClock,
    private readonly fetcher: IFetcher = { fetch: (url) => globalThis.fetch(url) },
    maxLookbackMs: number = MAX_LOOKBACK_MS,
  ) {
    this.maxLookbackMs = maxLookbackMs;
  }

  /**
   * Poll the relay for messages missed during the last hibernation.
   * Always resolves (never throws) — startup must not block on relay availability.
   */
  async pollMissedMessages(): Promise<void> {
    try {
      const nowMs = this.clock.now().getTime();
      const cutoffMs = nowMs - this.maxLookbackMs;

      // Compute anchor: the earliest lastSeen across all known peers, bounded by 7-day cap.
      const lastSeenAll = await this.stateStore.getLastSeenAll();
      const values = Object.values(lastSeenAll);
      const minLastSeen = values.length > 0 ? Math.min(...values) : 0;
      const since = Math.max(minLastSeen, cutoffMs);

      const sinceIso = new Date(since).toISOString();
      this.logger.debug(`[AGORA] Wake poll: fetching missed messages since ${sinceIso} (${values.length} peer anchor(s))`);

      const url =
        `${this.relayRestUrl}/api/relay/replay` +
        `?since=${since}&peer=${encodeURIComponent(this.selfPubkey)}`;

      let response: { ok: boolean; status: number; json(): Promise<unknown> };
      try {
        response = await this.fetcher.fetch(url);
      } catch (err) {
        this.logger.debug(
          `[AGORA] Wake poll: relay unreachable (${this.relayRestUrl}) — ${err instanceof Error ? err.message : String(err)}`
        );
        return;
      }

      if (!response.ok) {
        this.logger.debug(`[AGORA] Wake poll: relay returned HTTP ${response.status} — skipping replay`);
        return;
      }

      const data = await response.json() as ReplayResponse;
      const messages: Envelope[] = Array.isArray(data?.messages) ? data.messages : [];

      this.logger.debug(`[AGORA] Wake poll: received ${messages.length} replayed message(s)`);

      let injected = 0;
      for (const envelope of messages) {
        try {
          const verified = this.verifyFn(envelope);
          if (!verified.valid) {
            this.logger.debug(
              `[AGORA] Wake poll: skipping envelope ${envelope.id} — ${verified.reason ?? "invalid signature"}`
            );
            continue;
          }
          await this.messageHandler.processEnvelope(envelope, "relay");
          injected++;
        } catch (err) {
          this.logger.debug(
            `[AGORA] Wake poll: failed to process envelope ${envelope.id} — ` +
            `${err instanceof Error ? err.message : String(err)}`
          );
        }
      }

      if (messages.length > 0) {
        this.logger.debug(`[AGORA] Wake poll: processed ${injected}/${messages.length} replayed message(s)`);
      }
    } catch (err) {
      // Outermost catch: never propagate errors to the startup sequence.
      this.logger.debug(
        `[AGORA] Wake poll: unexpected error — ${err instanceof Error ? err.message : String(err)}`
      );
    }
  }

  /**
   * Derive a REST base URL from a WebSocket relay URL.
   * Converts `ws://host:port` → `http://host:port` and `wss://host:port` → `https://host:port`.
   * Returns null if the input is not a valid URL.
   */
  static deriveRestUrl(wsUrl: string): string | null {
    try {
      const u = new URL(wsUrl);
      u.protocol = u.protocol === "wss:" ? "https:" : "http:";
      u.pathname = "";
      u.search = "";
      u.hash = "";
      return u.origin;
    } catch {
      return null;
    }
  }
}
