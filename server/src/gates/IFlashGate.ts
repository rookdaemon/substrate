import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

/**
 * F2 FlashGate decision — outcome of evaluating a single inbound envelope.
 *
 * - PASS:     message is clean; proceed normally.
 * - ESCALATE: anomaly detected; let the message through but flag it for review.
 * - BLOCK:    hard anomaly; drop the message without further processing.
 */
export type FlashGateDecision = "PASS" | "ESCALATE" | "BLOCK";

export interface FlashGateResult {
  decision: FlashGateDecision;
  /** Human-readable reason for non-PASS decisions. */
  reason?: string;
}

/**
 * F2 FlashGate — pre-input behavioral gate that runs before message injection.
 *
 * Currently scoped to `dm` and `publish` envelope types.
 */
export interface IFlashGate {
  evaluate(envelope: Envelope): Promise<FlashGateResult>;
}
