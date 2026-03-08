import type { Envelope } from "@rookdaemon/agora" with { "resolution-mode": "import" };

export type FlashGateVerdict = "PROCEED" | "BLOCK" | "ESCALATE";

/**
 * F2 FlashGate decision — outcome of the lightweight pre-check (timestamp anomaly, etc.)
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
 * Summary of a parent envelope, used to provide inReplyTo chain context
 * when evaluating a message that is a reply to a prior message.
 */
export interface EnvelopeSummary {
  envelopeId: string;
  senderMoniker: string;
  /** Truncated text excerpt from the envelope payload. */
  text: string;
}

export interface F2GateInput {
  gate: "F2";
  context: {
    sender_moniker: string;
    /** True when the sender is a known/verified peer in PEERS registry. */
    sender_verified: boolean;
    message_text: string;
    message_type: string;
    envelope_id: string;
    timestamp: string;
    /** Optional context from the parent envelope when inReplyTo is set. */
    inReplyToSummary?: EnvelopeSummary;
    /** Human-readable description of sender's role in the architecture. */
    peer_context?: string;
  };
}

export interface F2GateResult {
  verdict: FlashGateVerdict;
  reasons: string[];
  /** True when the evaluation timed out (verdict will be BLOCK). */
  timedOut?: boolean;
}

export interface IFlashGate {
  /**
   * Lightweight pre-check on a raw envelope (timestamp anomaly, etc.).
   * Runs before the full LLM-based evaluation.
   * Currently scoped to `dm` and `publish` envelope types.
   */
  evaluate(envelope: Envelope): Promise<FlashGateResult>;

  /**
   * Evaluate an inbound Agora message through the F2 (Healthy Paranoia) gate.
   *
   * Returns:
   * - PROCEED: message is safe to process normally
   * - BLOCK: message should be discarded
   * - ESCALATE: message should be processed with an escalation flag
   */
  evaluateF2(input: F2GateInput): Promise<F2GateResult>;
}
