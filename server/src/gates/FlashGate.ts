import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };
import type { IClock } from "../substrate/abstractions/IClock";
import type { ILogger } from "../logging";
import type { IFlashGate, FlashGateResult } from "./IFlashGate";

/**
 * Message types that the FlashGate actively gates.
 * All other types receive an unconditional PASS.
 */
const GATED_TYPES = new Set(["dm", "publish"]);

/**
 * Maximum allowed clock drift (ms) between an envelope's timestamp and the
 * local wall clock.  Messages whose timestamps fall outside this window are
 * flagged as anomalous.
 *
 * 5 minutes matches common NTP slew tolerances while staying well above
 * normal network round-trip variance.
 */
const TIMESTAMP_TOLERANCE_MS = 5 * 60 * 1000;

/**
 * F2 FlashGate — pre-input behavioral gate.
 *
 * Checks inbound `dm` / `publish` envelopes for timestamp anomalies and
 * returns a structured decision before the message is injected into the loop.
 *
 * ## Issue C fix (FP11-12, FP18, FP21)
 * The epoch comparison previously used:
 *
 *   ```ts
 *   const epoch = Date.parse(timestamp.slice(0, 10));  // BUG: truncates to YYYY-MM-DD
 *   ```
 *
 * Slicing an ISO timestamp to the first 10 characters produces `"YYYY-MM-DD"`,
 * which `Date.parse` resolves to **midnight UTC** of that day.  Any message
 * sent after midnight on the same calendar day therefore appeared to be
 * drifted into the future, producing a uniform same-day false-positive
 * distribution (FP11-12, FP18, FP21).
 *
 * The fix uses the **full** ISO string so the parsed epoch matches the actual
 * send time:
 *
 *   ```ts
 *   const epoch = Date.parse(timestamp);  // correct
 *   ```
 */
export class FlashGate implements IFlashGate {
  constructor(
    private readonly clock: IClock,
    private readonly logger: ILogger,
  ) {}

  async evaluate(envelope: Envelope): Promise<FlashGateResult> {
    if (!GATED_TYPES.has(envelope.type)) {
      return { decision: "PASS" };
    }

    return this.checkTimestampAnomaly(envelope);
  }

  private checkTimestampAnomaly(envelope: Envelope): FlashGateResult {
    const now = this.clock.now().getTime();

    // Use the numeric envelope timestamp directly (milliseconds since epoch).
    //
    // FIX (Issue C): The previous implementation converted envelope.timestamp to
    // an ISO string and then called Date.parse(timestamp.slice(0, 10)), which
    // truncated to "YYYY-MM-DD" and resolved to midnight UTC.  Any message sent
    // after midnight on the same calendar day appeared drifted by up to 24 h,
    // producing a uniform same-day false-positive distribution (FP11-12, FP18, FP21).
    const epoch = envelope.timestamp;

    const drift = Math.abs(now - epoch);
    if (drift > TIMESTAMP_TOLERANCE_MS) {
      this.logger.debug(
        `[FLASHGATE] Timestamp anomaly: envelopeId=${envelope.id} drift=${drift}ms tolerance=${TIMESTAMP_TOLERANCE_MS}ms`,
      );
      return {
        decision: "ESCALATE",
        reason: `Timestamp anomaly: drift=${drift}ms exceeds tolerance=${TIMESTAMP_TOLERANCE_MS}ms`,
      };
    }

    return { decision: "PASS" };
  }
}
